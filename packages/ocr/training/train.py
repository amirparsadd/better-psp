"""Trains the digit classifier from crops written by `pnpm crops`.

    uv run train.py --data <crops root> --out <run> --cv 5    held-out accuracy on the real captchas
    uv run train.py --data <crops root> --out <run> --final   train on everything (reuses the --cv temperature)
    uv run export.py <run>/final.pt                           write src/model/digits.ts

<crops root> holds one folder per `pnpm crops --out` run (crops.u8 + crops.jsonl). Cross-validation folds group real
crops by captcha and spread each gateway over the folds, so a captcha's five digits are always held out together.
Every reported number comes from the int8 model the extension runs, not the float one.
"""

import argparse
import json
import math
import random
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from export import dequantized, serialize
from model import CLASSES, DigitNet

SOURCES = ("real", "synthetic", "chars74k", "sliver", "reject")
REJECT = 10


def load(root: Path) -> tuple[torch.Tensor, torch.Tensor, list[dict]]:
    images, metas = [], []
    for jsonl in sorted(root.glob("*/crops.jsonl")):
        lines = [json.loads(line) for line in jsonl.read_text().splitlines() if line]
        images.append(np.fromfile(jsonl.parent / "crops.u8", dtype=np.uint8).reshape(len(lines), 32, 32))
        metas += lines
    x = torch.from_numpy(np.concatenate(images)).float().div_(255).unsqueeze(1)
    y = torch.tensor([REJECT if m["label"] == "x" else int(m["label"]) for m in metas])
    return x, y, metas


def assign_folds(metas: list[dict], k: int, seed: int) -> dict[str, int]:
    rng = random.Random(seed)
    by_gateway = defaultdict(set)
    for m in metas:
        if m["source"] == "real":
            by_gateway[m["gateway"]].add(m["sample"])
    folds, offset = {}, 0
    for gateway in sorted(by_gateway):
        samples = sorted(by_gateway[gateway])
        rng.shuffle(samples)
        for i, sample in enumerate(samples):
            folds[sample] = (i + offset) % k
        offset += len(samples)
    return folds


def stroke_bank(generator: torch.Generator, count: int = 512) -> torch.Tensor:
    """Thin straight strokes at random angles and offsets, like the lines gateways draw over the digits."""
    bar = torch.zeros(count, 1, 32, 32)
    thickness = torch.randint(1, 3, (count,), generator=generator)
    for i in range(count):
        bar[i, 0, 16 - int(thickness[i]) // 2 : 16 + (int(thickness[i]) + 1) // 2] = 1
    angle = torch.rand(count, generator=generator) * math.pi
    shift = (torch.rand(count, 2, generator=generator) * 2 - 1) * 0.6
    length = 0.6 + torch.rand(count, generator=generator) * 1.6
    theta = torch.zeros(count, 2, 3)
    theta[:, 0, 0] = torch.cos(angle) * length
    theta[:, 0, 1] = -torch.sin(angle)
    theta[:, 1, 0] = torch.sin(angle) * length
    theta[:, 1, 1] = torch.cos(angle)
    theta[:, :, 2] = shift
    grid = F.affine_grid(theta, bar.shape, align_corners=False)
    return F.grid_sample(bar, grid, align_corners=False).clamp_(0, 1)


def augment(x: torch.Tensor, strokes: torch.Tensor, generator: torch.Generator) -> torch.Tensor:
    b = x.shape[0]
    rand = lambda *shape: torch.rand(*shape, generator=generator)

    # Small rotation, shear, zoom, aspect change and shift.
    angle = (rand(b) * 2 - 1) * math.radians(10)
    shear = (rand(b) * 2 - 1) * 0.3
    zoom = 0.85 + rand(b) * 0.3
    aspect = 0.85 + rand(b) * 0.3
    theta = torch.zeros(b, 2, 3)
    theta[:, 0, 0] = torch.cos(angle) * zoom * aspect
    theta[:, 0, 1] = (-torch.sin(angle) + shear) * zoom
    theta[:, 1, 0] = torch.sin(angle) * zoom * aspect
    theta[:, 1, 1] = torch.cos(angle) * zoom
    theta[:, :, 2] = (rand(b, 2) * 2 - 1) * 0.08
    x = F.grid_sample(x, F.affine_grid(theta, x.shape, align_corners=False), align_corners=False)

    # Bolder or thinner strokes.
    pick = rand(b, 1, 1, 1)
    x = torch.where(pick < 0.15, F.max_pool2d(x, 3, 1, 1), x)
    x = torch.where(pick > 0.92, -F.max_pool2d(-x, 3, 1, 1), x)

    # Leftover crossing lines and specks.
    with_stroke = (rand(b, 1, 1, 1) < 0.3).float()
    x = torch.maximum(x, strokes[torch.randint(len(strokes), (b,), generator=generator)] * with_stroke)
    specks = (rand(b, 1, 32, 32) < 0.004 * rand(b, 1, 1, 1)).float()
    x = torch.maximum(x, F.max_pool2d(specks, 2, 1, 1)[..., :32, :32])

    # Broken strokes: a small hole punched somewhere.
    cut = rand(b) < 0.2
    for i in torch.nonzero(cut).flatten().tolist():
        cx, cy = torch.randint(4, 28, (2,), generator=generator).tolist()
        x[i, 0, cy - 2 : cy + 2, cx - 2 : cx + 2] = 0
    return x.clamp_(0, 1)


def train(x, y, indices: dict[str, torch.Tensor], args, seed: int) -> DigitNet:
    torch.manual_seed(seed)
    generator = torch.Generator().manual_seed(seed)
    strokes = stroke_bank(generator)
    model = DigitNet(args.width)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=5e-4)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=args.steps, pct_start=0.1)

    present = [s for s in SOURCES if len(indices.get(s, [])) > 0]
    mix = torch.tensor([args.mix[s] for s in present])
    model.train()
    for step in range(args.steps):
        counts = torch.bincount(torch.multinomial(mix, args.batch, True, generator=generator), minlength=len(present))
        batch = torch.cat([
            indices[s][torch.randint(len(indices[s]), (int(n),), generator=generator)] for s, n in zip(present, counts)
        ])
        inputs = augment(x[batch], strokes, generator)
        loss = F.cross_entropy(model(inputs), y[batch], label_smoothing=0.05)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        schedule.step()
        if (step + 1) % 1000 == 0:
            print(f"    step {step + 1}/{args.steps} loss {loss.item():.3f}", flush=True)
    return model.eval()


@torch.no_grad()
def shipped_logits(model: DigitNet, x: torch.Tensor) -> torch.Tensor:
    return dequantized(serialize(model, 1.0))(x)


def fit_temperature(logits: torch.Tensor, labels: torch.Tensor) -> float:
    log_t = torch.zeros(1, requires_grad=True)
    optimizer = torch.optim.LBFGS([log_t], lr=0.1, max_iter=200)

    def closure():
        optimizer.zero_grad()
        loss = F.cross_entropy(logits / log_t.exp(), labels)
        loss.backward()
        return loss

    optimizer.step(closure)
    return float(log_t.detach().exp())


def report(results: list[dict]) -> None:
    """Per-gateway digit and captcha accuracy, then how many captchas each confidence bar would fill and get wrong."""
    by_gateway = defaultdict(list)
    for r in results:
        by_gateway[r["gateway"]].append(r)
    print(f"\n{'gateway':14} {'n':>3} {'digits':>7} {'exact':>7}")
    for gateway in sorted(by_gateway) + ["ALL"]:
        rows = results if gateway == "ALL" else by_gateway[gateway]
        digits = sum(sum(p == l for p, l in zip(r["text"], r["label"])) for r in rows) / (5 * len(rows))
        exact = sum(r["text"] == r["label"] for r in rows) / len(rows)
        print(f"{gateway:14} {len(rows):3} {digits:7.1%} {exact:7.1%}")
    print(f"\n{'confidence':>10} {'filled':>7} {'wrong fill':>10}")
    for bar in (0, 50, 60, 70, 80, 90, 95):
        filled = [r for r in results if r["confidence"] >= bar]
        wrong = sum(r["text"] != r["label"] for r in filled)
        print(f"{bar:10} {len(filled) / len(results):7.1%} {wrong / max(1, len(filled)):10.1%}")


def captcha_results(logits: torch.Tensor, metas: list[dict], rows: list[int], temperature: float, folds) -> list[dict]:
    # The answer is the likeliest digit; "not one digit" only lowers its probability.
    probabilities = torch.softmax(logits / temperature, dim=1)
    grouped = defaultdict(list)
    for row, p in zip(rows, probabilities):
        grouped[metas[row]["sample"]].append((metas[row], p))
    results = []
    for sample, digits in grouped.items():
        best = [p[:REJECT].max().item() for _, p in digits]
        results.append({
            "sample": sample,
            "gateway": digits[0][0]["gateway"],
            "fold": folds.get(sample) if folds else None,
            "label": "".join(m["label"] for m, _ in digits),
            "text": "".join(str(int(p[:REJECT].argmax())) for _, p in digits),
            "confidence": 100 * min(best),
            "probabilities": [[round(v, 4) for v in p.tolist()] for _, p in digits],
        })
    return sorted(results, key=lambda r: r["sample"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cv", type=int, default=0, help="number of folds; 0 skips cross-validation")
    parser.add_argument("--final", action="store_true", help="train on all crops and write final.pt")
    parser.add_argument("--no-real", action="store_true")
    parser.add_argument("--no-synthetic", action="store_true")
    parser.add_argument("--no-chars74k", action="store_true")
    parser.add_argument("--no-sliver", action="store_true")
    parser.add_argument("--no-reject", action="store_true")
    parser.add_argument(
        "--mix", default="real=0.35,synthetic=0.35,chars74k=0.1,sliver=0.1,reject=0.1", help="share of each source per batch"
    )
    parser.add_argument("--steps", type=int, default=5000)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--width", type=int, default=16)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--threads", type=int, default=16)
    args = parser.parse_args()
    args.mix = {k: float(v) for k, v in (part.split("=") for part in args.mix.split(","))}
    torch.set_num_threads(args.threads)
    args.out.mkdir(parents=True, exist_ok=True)

    x, y, metas = load(args.data)
    excluded = {s for s in SOURCES if getattr(args, f"no_{s}")}
    by_source = defaultdict(list)
    for i, m in enumerate(metas):
        by_source[m["source"]].append(i)
    print(" ".join(f"{s}={len(by_source[s])}" for s in SOURCES), f"excluded={sorted(excluded) or '-'}")
    real_rows = by_source["real"]

    def training_indices(keep_real) -> dict[str, torch.Tensor]:
        chosen = {s: by_source[s] for s in SOURCES if s not in excluded and s != "real"}
        if "real" not in excluded:
            chosen["real"] = [i for i in real_rows if keep_real(metas[i]["sample"])]
        return {s: torch.tensor(v, dtype=torch.long) for s, v in chosen.items()}

    if args.cv:
        folds = assign_folds(metas, args.cv, args.seed)
        (args.out / "folds.json").write_text(json.dumps(folds, indent=1))
        logits = torch.zeros(len(real_rows), CLASSES)
        models = []
        for k in range(args.cv):
            started = time.time()
            held_out = [j for j, i in enumerate(real_rows) if folds[metas[i]["sample"]] == k]
            print(f"fold {k}: {len(held_out) // 5} captchas held out", flush=True)
            model = train(x, y, training_indices(lambda s: folds[s] != k), args, args.seed + k)
            logits[held_out] = shipped_logits(model, x[[real_rows[j] for j in held_out]])
            models.append(model)
            print(f"    {time.time() - started:.0f}s", flush=True)
        temperature = fit_temperature(logits, y[real_rows])
        for k, model in enumerate(models):
            (args.out / f"fold-{k}.json").write_text(json.dumps(serialize(model, temperature)))
        results = captcha_results(logits, metas, real_rows, temperature, folds)
        (args.out / "cv.json").write_text(json.dumps({"temperature": temperature, "args": vars(args) | {
            "data": str(args.data), "out": str(args.out)}, "results": results}, indent=1))
        print(f"\nheld-out results, temperature {temperature:.3f}")
        report(results)

    if args.final:
        cv_file = args.out / "cv.json"
        temperature = json.loads(cv_file.read_text())["temperature"] if cv_file.exists() else 1.0
        model = train(x, y, training_indices(lambda s: True), args, args.seed)
        parity = x[real_rows[::max(1, len(real_rows) // 8)][:8], 0].numpy()
        torch.save({"state": model.state_dict(), "width": args.width, "temperature": temperature,
                    "parity_inputs": parity}, args.out / "final.pt")
        (args.out / "final.json").write_text(json.dumps(serialize(model, temperature)))
        print(f"wrote {args.out / 'final.pt'} (temperature {temperature:.3f})")


if __name__ == "__main__":
    main()
