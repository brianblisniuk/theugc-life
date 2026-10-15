# UX02 contrast — WCAG 2.2 AA

Computed from the sRGB relative luminance of the tokens in `assets/tokens.css`. Ratios are (lighter + 0.05) / (darker + 0.05). Normal text needs 4.5:1. Non-text UI boundaries need 3:1. Large text (24px regular or 18.7px bold) needs 3:1; these frames still keep body, labels, and buttons at 4.5:1.

The accent `#DFFF4F` is a fill. It is not used for text or icons on light surfaces. Text on the accent is `#17191B` in both themes.

## Light (master)

| Pair | Colors | Ratio | AA |
| --- | --- | --- | --- |
| Text on paper | `#17191B` on `#FAFAF8` | 16.87:1 | Pass |
| Text on surface | `#17191B` on `#FFFFFF` | 17.63:1 | Pass |
| Secondary on paper | `#52585E` on `#FAFAF8` | 6.89:1 | Pass |
| Secondary on surface | `#52585E` on `#FFFFFF` | 7.20:1 | Pass |
| Muted, as specified | `#747A80` on `#FAFAF8` | 4.15:1 | Fail |
| Muted, as specified | `#747A80` on `#FFFFFF` | 4.34:1 | Fail |
| Muted, shipped | `#6C7379` on `#FAFAF8` | 4.60:1 | Pass |
| Muted, shipped | `#6C7379` on `#FFFFFF` | 4.81:1 | Pass |
| Ink on accent | `#17191B` on `#DFFF4F` | 15.57:1 | Pass |
| Accent fill on paper | `#DFFF4F` on `#FAFAF8` | 1.08:1 | Fail as a boundary |
| Accent fill on surface | `#DFFF4F` on `#FFFFFF` | 1.13:1 | Fail as a boundary |
| Button edge on paper | `#5E6C00` on `#FAFAF8` | 5.55:1 | Pass (3:1 boundary) |
| Button edge on surface | `#5E6C00` on `#FFFFFF` | 5.80:1 | Pass |
| Button edge on accent | `#5E6C00` on `#DFFF4F` | 5.12:1 | Pass |
| Success on paper | `#177245` on `#FAFAF8` | 5.69:1 | Pass |
| Success on soft | `#177245` on `#E5F4EC` | 5.24:1 | Pass |
| Warning on paper | `#A45113` on `#FAFAF8` | 5.34:1 | Pass |
| Warning on soft | `#A45113` on `#F8EDE4` | 4.84:1 | Pass |
| Danger on paper | `#B42332` on `#FAFAF8` | 6.23:1 | Pass |
| Danger on soft | `#B42332` on `#F8E6E8` | 5.42:1 | Pass |
| Focus on paper | `#225FCC` on `#FAFAF8` | 5.62:1 | Pass |
| Focus on process soft | `#225FCC` on `#E7EEF8` | 5.03:1 | Pass |
| Control border on paper | `#8A9094` on `#FAFAF8` | 3.09:1 | Pass for non-text |
| Control border on surface | `#8A9094` on `#FFFFFF` | 3.23:1 | Pass for non-text |
| Hairline | `#E3E6E7` on `#FAFAF8` | 1.20:1 | Not a control boundary |
| Initials on placeholder | `#17191B` on `#E4E6E2` | 14.03:1 | Pass |
| Private badge | `#243040` on `#E6EBF0` | 11.14:1 | Pass |

`#747A80` is the spec’s muted token and fails 4.5:1 for 12–14px text. The shipped `--muted` is `#6C7379`, the nearest neutral step that passes on both paper and white. Hairlines stay `#E3E6E7` and never identify a control by themselves. Inputs, secondary buttons, and chips use `--control-border`.

Primary buttons are accent fill, ink text, and a 1px `#5E6C00` border. The border is what separates the button from paper.

## Dark

Same token names. Status, muted, focus, and borders are lifted so the same roles still clear AA on `#121416` and `#1C1F22`. The accent and the ink on it do not change.

| Pair | Colors | Ratio | AA |
| --- | --- | --- | --- |
| Text on background | `#F4F5F3` on `#121416` | 16.88:1 | Pass |
| Text on surface | `#F4F5F3` on `#1C1F22` | 15.14:1 | Pass |
| Secondary on background | `#C8CDD1` on `#121416` | 11.53:1 | Pass |
| Secondary on surface | `#C8CDD1` on `#1C1F22` | 10.33:1 | Pass |
| Muted on background | `#A8AFB4` on `#121416` | 8.31:1 | Pass |
| Muted on surface | `#A8AFB4` on `#1C1F22` | 7.45:1 | Pass |
| Ink on accent | `#17191B` on `#DFFF4F` | 15.57:1 | Pass |
| Accent fill on background | `#DFFF4F` on `#121416` | 16.31:1 | Pass |
| Accent fill on surface | `#DFFF4F` on `#1C1F22` | 14.63:1 | Pass |
| Button edge on accent | `#5E6C00` on `#DFFF4F` | 5.12:1 | Pass |
| Success on surface | `#3EBE78` on `#1C1F22` | 6.97:1 | Pass |
| Success on soft | `#3EBE78` on `#13261C` | 6.69:1 | Pass |
| Warning on surface | `#E39A4A` on `#1C1F22` | 7.09:1 | Pass |
| Warning on soft | `#E39A4A` on `#2A2116` | 6.77:1 | Pass |
| Danger on surface | `#F08A84` on `#1C1F22` | 6.84:1 | Pass |
| Danger on soft | `#F08A84` on `#2C181C` | 6.91:1 | Pass |
| Focus on surface | `#8EB4FF` on `#1C1F22` | 7.98:1 | Pass |
| Focus on soft | `#8EB4FF` on `#172033` | 7.84:1 | Pass |
| Control border on surface | `#8B9196` on `#1C1F22` | 5.19:1 | Pass |
| Private badge | `#D5DCE3` on `#262C33` | 10.18:1 | Pass |
| Initials on placeholder | `#F4F5F3` on `#2C3130` | 12.08:1 | Pass |

Light `#177245`, `#A45113`, `#B42332`, and `#225FCC` are below 4.5:1 on the dark surfaces (about 2.5:1–3.3:1). Dark theme values for those four tokens are the AA-safe pair. They are not a second accent.

## Other checks

- Focus is a 2px solid `--focus` ring with a 2px offset. It is not the accent.
- Disabled controls use muted text on a neutral fill, not a reduced opacity that would drop them under 4.5:1.
- Pipeline stage, verification, and closure are written out. Color is not the only signal.
- Map pins are ink with a paper ring. They do not use the accent, price, or a probability scale.
- Targets for buttons, inputs, nav items, and pins are at least 44px. Chips are 32px with a 24px remove control inside a 32px chip; the chip row is not the only way to clear a filter (`Clear all` is 44px).
- `prefers-reduced-motion: reduce` removes animation and transitions. Skeletons do not shimmer.
