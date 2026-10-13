"""The digit classifier. Must stay in step with `createLogits` in src/classify.ts: three blocks of 3x3 convolution
(zero padding), batch norm, ReLU and 2x2 max pooling, then dense, ReLU, dense to 11 classes: the digits, then
"not one digit" (a bad split), which lets the solver tell a clean cut from a sliver of a glyph."""

from torch import nn

CLASSES = 11


class DigitNet(nn.Module):
    def __init__(self, width: int = 16):
        super().__init__()
        channels = [1, width, width * 2, width * 4]
        self.blocks = nn.ModuleList(
            nn.Sequential(
                nn.Conv2d(channels[i], channels[i + 1], 3, padding=1, bias=False),
                nn.BatchNorm2d(channels[i + 1]),
                nn.ReLU(),
                nn.MaxPool2d(2),
            )
            for i in range(3)
        )
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(channels[3] * 4 * 4, 64),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(64, CLASSES),
        )

    def forward(self, x):
        for block in self.blocks:
            x = block(x)
        return self.head(x)
