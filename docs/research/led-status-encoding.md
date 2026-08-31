# Single-pixel status encoding: prior art and perceptual limits

Research for [#3](https://github.com/lenken-dev/ossm/issues/3), part of the LED status system
map ([#2](https://github.com/lenken-dev/ossm/issues/2)). Findings only — the error-code
vocabulary is designed in [#7](https://github.com/lenken-dev/ossm/issues/7).

There is no existing research directory in this repo. This file establishes `docs/research/`,
sitting alongside `docs/adr/`. Notes here are evidence, not decisions; anything binding graduates
to an ADR.

---

## Summary of what changes the design

1. **The board's LED cannot be trusted below code 3 per channel.** Measurements of the newer
   WS2812 die revisions (the part sold as WS2812B-V5) show the LED emits *nothing* for PWM values
   1–2 and does not reach its steady current until value 7–8. `BOOT_COLOR` is code **5** per
   channel, which sits inside that ramp.
2. **`Rgb::scaled` at 0.02 destroys every hue that is not a corner of the RGB cube.** Amber
   `(255,128,0)` becomes `(5,2,0)`, and on a V5 part the `2` is dark, so amber renders as **red**.
   A colour-class scheme built on `scaled` would silently mis-report fault classes.
3. **Gamma correction must not be applied after the brightness scale.** `255·(c/255)^2.2` maps
   every code from 1 to 8 to zero. At 2% headroom there is nothing left to gamma-correct; the
   ramp is already inside CIE L\*'s linear segment.
4. **Prior art converges on ~1–2 s per element and a 1.5–3 s separator**, and on counts of 1–9
   per group, while human-factors evidence says only counts **up to 4** are read reliably. The
   curated-set decision already recorded in #2 is the right side of that tension; the ceiling is
   4, not 9.
5. **Colour identification, not colour discrimination, is the binding limit.** Observers can
   discriminate millions of colours side by side but absolutely identify roughly a dozen spectral
   hues at best, and far fewer in an applied display. A single LED demands absolute
   identification.

---

## Part A — Prior art: encoding codes on one light

### A.1 The four schemes actually in the field

**Colour class + two blink groups (Dell).** Dell's diagnostic power-button LED emits a group of
1–9 amber blinks, then a 1.5 s pause with the LED off, then a group of 1–9 white blinks, then a
3 s pause before repeating. Each blink itself takes 1.5 s. The amber group is the tens digit, the
white group the units.
Source: [Dell Latitude 3300 Service Manual — Diagnostic
LEDs](https://www.dell.com/support/manuals/en-us/latitude-13-3300-laptop/latitude_3300_om/diagnostic-leds?guid=guid-e0aef7bd-f282-4302-94d6-792e4aaa21ed&lang=en-us);
[Dell OptiPlex diagnostic indicators reference
guide](https://www.dell.com/support/kbdoc/en-us/000126021/a-reference-guide-to-the-dell-optiplex-diagnostic-indicators).

Note what Dell does *not* do: colour does not carry the fault class. It carries *position in the
number*. That is a different use of colour from the one #2 proposes, and worth knowing before
borrowing the timing wholesale.

**Long/short groupings (Raspberry Pi bootloader).** The activity LED emits zero or more *long*
flashes, then a run of *short* flashes; the two groups are counted separately and the pattern
repeats after a two-second gap. A code with no long flashes is valid — count only the shorts.
Examples: 3 short = generic boot failure, 4 short = `start*.elf` not found, 7 short = kernel image
not found, 1 long + 2 short = SD-card overcurrent, 2 long + 2 short = partition read failure.
Source: [Raspberry Pi documentation, LED warning flash
codes](https://www.raspberrypi.com/documentation/computers/configuration.html#led-warning-flash-codes).

**Morse-style positional weighting (OBD-I).** Pre-OBD-II engine management lamps encode a
two-digit code as long flashes worth ten and short flashes worth one, with a short gap between
digits, a medium gap between codes, and a long gap before the sequence loops. Each code repeats
three times before the next is sent.
Source: [Innova, Reading the blink codes for OBD1
vehicles](https://www.innova.com/blogs/fix-advices/reading-the-blink-codes-for-obd1-vehicles).

**Rate as the signal, not the count (UNECE R48).** The direction-indicator tell-tale flashes at
90 ± 30 cycles per minute (1.0–2.0 Hz). A lamp failure must be signalled by the tell-tale being
extinguished, staying lit without flashing, or showing "a marked change of frequency". This is the
canonical example of a rate deliberately chosen to read as *broken*.
Source: [UN Regulation No. 48, Rev.13](https://unece.org/sites/default/files/2025-04/R048r13e_0.pdf).

### A.2 What timings read as "deliberate"

**IEC 60073 is the anchor.** Its normal flashing rate band is **1.4–2.8 Hz** and its slow band is
**0.4–0.8 Hz**, with higher frequencies reserved for higher-priority information. IEC 60073:2002
itself is paywalled; the rates are quoted verbatim in IEEE P1621/D (15 Dec 2002), *Draft Standard
for User Interface Elements in Power Control of Electronic Devices*, §4.4.2–4.4.3, which
normatively references IEC 60073:2002 and CIE 107-1994.
Source: [IEEE P1621 draft, LBNL copy](https://ea-controls.lbl.gov/1621/docs/1621dec1502.pdf)
(quoted: "Per IEC 60073, normal flashing rates are 1.4 Hz to 2.8 Hz, and slow flashing rates are
between 0.4 Hz to 0.8 Hz").

**A heartbeat has a documented shape.** P1621 allows a power indicator that would otherwise be
intrusive to show "a brief flash … (e.g. one tenth of a second on followed by 1.9 seconds off)".
That is a usable lower bound on flash duration (100 ms on) and a usable "alive, nothing to report"
idle for a machine whose LED sits in a bedroom.

**The bands, assembled.** Nothing in the sources labels a rate "broken" outright, but the ranges
partition cleanly:

| Behaviour | Rate / duration | Reads as |
| --- | --- | --- |
| Steady | — | A state, not an event |
| Heartbeat blink | 100 ms on / 1.9 s off | Alive, idle (P1621) |
| Slow flash | 0.4–0.8 Hz | Low-priority / informational (IEC 60073) |
| Countable blink | ~1.5 s per blink (Dell), 2 s inter-group gap (RPi) | A code being transmitted |
| Normal flash | 1.4–2.8 Hz | Attention, in-band (IEC 60073) |
| Marked rate change | any deliberate departure | A fault (UNECE R48) |
| Above ~4–5 Hz | — | Uncountable; reads as agitation or malfunction |

The important structural point: **counting rate and attention rate are different bands.** IEC
60073's 1.4–2.8 Hz attention flash is 2–4× faster than the ~0.67 Hz implied by Dell's 1.5 s
blinks. A code the user is meant to *count* must be slower than an alarm they are meant to
*notice*. Using one rate for both makes the code uncountable and the alarm sluggish.

### A.3 How many blinks a human can actually count

**Subitizing caps at four.** The term was coined by Kaufman, Lord, Reese and Volkmann (1949) for
rapid, confident, accurate report of small numerosities; performance is essentially perfect up to
about five and the characteristic break in the response-time curve is at **four**.
Source: [Kaufman, Lord, Reese & Volkmann, "The discrimination of visual number", *Am. J.
Psychol.* 62(4), 1949](https://www.semanticscholar.org/paper/2e8136581d934e18eb17d124f0224a32b01272d5).

**The limit survives sequential presentation, but only to four.** With stimuli presented one at a
time (250 ms each, 1500 ms apart) subitizing is errorless across the 1–4 range and independent of
numerical ratio; above that, performance degrades to Weber-law estimation.
Source: [Anobile et al., "Subitizing endures in sequential rather than simultaneous comparison
tasks", PMC11444722](https://pmc.ncbi.nlm.nih.gov/articles/PMC11444722/).

**Above four, sequences are *under*-counted, and faster sequences worse.** In temporal numerosity
judgement, two items produce no significant bias, but counts above four show significant
underestimation, worsening as the inter-stimulus interval shortens.
Source: [Nagai et al., "Underestimation in temporal numerosity judgments computationally
explained by population coding model", *Sci. Rep.* 12, 2022,
PMC9482646](https://pmc.ncbi.nlm.nih.gov/articles/PMC9482646/).

**Visual sequences are the *worst* modality for this.** Cross-modal work found visual judgements
of sequential number consistently the least accurate of the modalities tested and biased toward
underestimation, with error rising sharply as rate went from 3 to 6 per second.
Source: [Lechelt, "Temporal numerosity discrimination: intermodal comparisons revisited", *Br. J.
Psychol.* 66(1), 1975, PMID 1131477](https://pubmed.ncbi.nlm.nih.gov/1131477/).

**Consequence.** Dell's 1–9 and the Pi's 7-short code are outside what a user reads reliably in
one pass; they work only because the user is expected to watch several repeats with a manual
open. The design constraint for this machine — a user standing over it, mid-session, without
documentation — is **counts of 1–4, one group**, with a pause long enough that a miscount is
recoverable on the next repeat. This corroborates the "small curated set" framing already settled
in #2 and puts a number on it.

### A.4 Colour semantics worth not reinventing

IEC 60073 / IEC 60204-1 assign indicator colours by the urgency of the response required: **red**
= emergency, act immediately; **yellow/amber** = abnormal, has drifted out of band, act to avoid
red; **green** = normal; **blue** = mandatory operator action; **white** = neutral, no meaning
assigned.
Source: [Machinery Safety 101, "Understanding safety functions: Indicators and
alarms"](https://machinerysafety101.com/2023/06/09/understanding-safety-functions-indicators-and-alarms/)
(summarising IEC 60073:2002 / IEC 60204-1; the standards themselves are paywalled).

P1621 adds two rules that matter to a single-pixel design because they solve "one light, two
things to say":

- An error may be shown by **red in place of** the power indication — in which case power state is
  no longer being communicated. That is exactly the "status pre-empts pattern lighting" rule in #2,
  and it comes with the standard's acknowledgement of the cost.
- **Alternating** red/green or red/yellow communicates an error *and* power state simultaneously.
- Where red is unavailable, alternating green and yellow at the normal flashing rate may signal an
  error, "but shall not be used to indicate that a safety hazard is present".

Note the interaction with the boot colour: `BOOT_COLOR` is white, which IEC 60073 defines as the
*neutral, no-assigned-meaning* colour. That is the correct choice for "the firmware ran and claims
nothing more" (ADR-0001) and should be preserved deliberately, not by accident.

### A.5 How many colours can be a class

Discrimination and identification are different capacities. A normal observer discriminates well
over a million colours side by side, but Halsey and Chapanis found the average observer can
absolutely identify **no more than about 12 spectral hues** under laboratory conditions, and
argued the applied-display number is lower.
Source: [Halsey & Chapanis, "On the number of absolutely identifiable spectral hues", *JOSA*
41(12):1057, 1951](https://opg.optica.org/josa/abstract.cfm?uri=josa-41-12-1057).

Twelve is the ceiling under ideal conditions with a trained observer. For an untrained user, one
small point source, no reference sample, and the hue quantisation established in Part B, the
working number is **3–5 classes**.

---

## Part B — Perceptual and electrical limits of this pixel

Facts below are for the WS2812B on GPIO38 of `ossm-alt`
(`firmware/esp32s3/src/bin/ossm-alt.rs`), driven by `ossm-esp/src/led/ws2812.rs`.

### B.1 What the datasheet says

- 8 bits per channel, 256 levels, GRB on the wire, MSB first; scan frequency "not less than
  400 Hz". Data rate 800 kbps.
  Source: [WS2812B datasheet (SparkFun
  mirror)](https://cdn.sparkfun.com/assets/e/6/1/f/4/WS2812B-LED-datasheet.pdf).
- Per-colour luminous intensity at full scale, from the RGB IC characteristic table. **Datasheet
  revisions disagree**, and both disagree in the same direction:

  | | Wavelength | Luminous intensity | Vf |
  | --- | --- | --- | --- |
  | Red (SparkFun rev.) | 620–630 nm | 550–700 mcd | 1.8–2.2 V |
  | Green (SparkFun rev.) | 515–530 nm | 1100–1400 mcd | 3.0–3.2 V |
  | Blue (SparkFun rev.) | 465–475 nm | 200–400 mcd | 3.0–3.4 V |
  | Red (Adafruit rev.) | 620–625 nm | 390–420 mcd | 2.0–2.2 V |
  | Green (Adafruit rev.) | 522–525 nm | 660–720 mcd | 3.0–3.4 V |
  | Blue (Adafruit rev.) | 465–467 nm | 180–200 mcd | 3.0–3.4 V |

  Sources: [SparkFun mirror](https://cdn.sparkfun.com/assets/e/6/1/f/4/WS2812B-LED-datasheet.pdf),
  [Adafruit mirror](https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf).

  **The channels are not equally bright at equal codes.** Green is 2.0–2.6× red and 2.8–7.0× blue.
  Equal RGB codes do not produce neutral white and do not produce equal-weight mixes; a "yellow"
  built as `(n, n, 0)` is dominated by its green.

- The V5 revision raises the required reset time to >280 µs and the internal refresh to 2 kHz.
  Source: [WS2812B-V5/W datasheet, LCSC
  mirror](https://datasheet.lcsc.com/lcsc/2206131216_Worldsemi-WS2812B-V5-W_C2874885.pdf) (PDF
  behind a redirect; the >280 µs reset and 2 kHz refresh figures are the ones already encoded in
  `ws2812.rs`).

### B.2 What the datasheet does not say, and measurement does

cpldcpu's oscilloscope and photometer characterisation of WS2812 revisions is the primary
measurement source here; the behaviour it documents is **absent from every datasheet revision**.

- The PWM engine is internally **11-bit**, and the 8-bit input value is mapped to it
  **non-linearly**. Low inputs (roughly up to 20) map to a *shorter* duty than linear, so the LED
  is dimmer than the code implies.
- PWM frame rate on the original WS2812S is **395.6 Hz** (clock 404.8 kHz), minimum pulse 1.1 µs.
  Newer revisions (WS2812C/D, and the V5) run the PWM at **2 kHz** (clock 2.08 MHz).
- **The critical one.** Newer revisions replaced instant current switching with a slow ramp, to
  cut EMI. Consequence: "the LED does not turn on at all for PWM=1-2, and does only reach maximum
  current for PWM>7". Measured: values 1–2 produce no LED output at all — only double current
  peaks marking the start of the PWM cycle — current ramps appear from value 3, and reach steady
  state around value 8.
- Clone parts (SK6812, TX1812) map input to brightness strictly linearly instead, with 1:256
  dynamic range against the WS2812's 1:2048.
- The author's verdict on the whole question: "Does the WS2812 have integrated gamma correction?
  No, but it has a feature to extend the dynamic range a little."
- Measured per-channel current ≈ **17 mA**, against a 20 mA nominal — note that some datasheet
  revisions state a 5 mA constant-current output. Treat the datasheet current figure as
  unreliable.

Sources: [cpldcpu, "Does the WS2812 have integrated
Gamma-Correction?"](https://cpldcpu.com/2022/08/15/does-the-ws2812-have-integrated-gamma-correction/);
[cpldcpu, "Power Analysis: Probing WS2812 RGB
LEDs"](https://cpldcpu.com/2020/12/19/power-analysis-probing-ws2812-rgb-leds/).

**This applies to us.** `ws2812.rs` deliberately picks timings in the overlap of the original and
V5 windows because "the two cannot be told apart in software". The same is true of this
behaviour: the firmware cannot know whether codes 1–2 will light. Any encoding must therefore
treat **3 as the lowest usable per-channel code** on all revisions.

### B.3 The practical minimum non-zero level

**Code 3.** Not 1.

The per-channel alphabet available at the current 2% headroom is therefore `{0, 3, 4, 5}` — four
states, three of which sit inside the V5's current ramp and so are not at their nominal
brightness. `BOOT_COLOR`'s code 5 is two steps above the floor.

At 2 kHz with an 11-bit engine, a single 8-bit LSB is ~1.95 µs of on-time (0.24 µs at 11-bit
resolution) — the region where the ramp circuit dominates, which is why the bottom codes behave
the way they do.

### B.4 How `Rgb::scaled` interacts with that floor

`Rgb::scaled` truncates each channel independently (documented in `ossm/src/led.rs`). At
`factor = 0.02` this is not a dimming operation, it is a **hue-destroying quantisation**:

| Colour | Full | `.scaled(0.02)` | As rendered on a V5 (codes <3 dark) |
| --- | --- | --- | --- |
| white | (255,255,255) | (5,5,5) | (5,5,5) white |
| red | (255,0,0) | (5,0,0) | (5,0,0) red |
| green | (0,255,0) | (0,5,0) | (0,5,0) green |
| blue | (0,0,255) | (0,0,5) | (0,0,5) blue |
| yellow | (255,255,0) | (5,5,0) | (5,5,0) yellow |
| cyan | (0,255,255) | (0,5,5) | (0,5,5) cyan |
| magenta | (255,0,255) | (5,0,5) | (5,0,5) magenta |
| **amber** | (255,128,0) | (5,2,0) | **(5,0,0) — red** |
| **purple** | (128,0,255) | (2,0,5) | **(0,0,5) — blue** |
| **lime** | (128,255,0) | (2,5,0) | **(0,5,0) — green** |
| **pink** | (255,105,180) | (5,2,3) | **(5,0,3) — magenta-ish** |
| orange | (255,165,0) | (5,3,0) | (5,3,0) — survives, barely |

Only the eight corners of the RGB cube survive intact. Amber — the IEC 60073 "abnormal" colour,
and the obvious warning class — collapses onto red, the emergency colour. A colour-class scheme
that computes colours at full scale and then calls `.scaled(0.02)` would report the wrong severity
class with no error anywhere in the system.

The fix is structural, not a rounding tweak: **choose the low-brightness codes directly**, or
scale in a wider integer domain and only quantise once, at the driver boundary. `scaled` as it
stands is fine for what ADR-0001 uses it for (one white boot colour) and unfit as the basis of a
palette.

### B.5 How many hues stay distinguishable

Counting the arithmetic first. With a maximum channel of 5, saturated colours around the RGB hue
circle give 6 segments × 5 steps = **30 hue positions, 12° apart** (against 1530 positions, 0.24°
apart, at full scale). Excluding codes 1–2 as dark drops that to **six** fully-saturated hues —
the cube corners — plus a handful of near-corner mixes such as `(5,3,0)`.

Arithmetic is the generous bound. Three perceptual effects narrow it further:

- **Small-field tritanopia.** For fields around **20 minutes of arc** and smaller, colour matches
  become dichromatic: blue–yellow discrimination is lost. Willmer and Wright established this for
  a 20′ bipartite field, and it holds for small fields generally, not only the fovea.
  Sources: [Mollon, "A taxonomy of
  tritanopias"](https://vision.psychol.cam.ac.uk/jdmollon/papers/Mollon1982Tritanopias.pdf)
  (reviews the Willmer & Wright result and its extension beyond the fovea); ["Foveal tritanopia",
  *Nature* 160:647](https://www.nature.com/articles/160647a0); ["Tritanopia and colour vision",
  *Nature* 157:106](https://www.nature.com/articles/157106b0).

  The 5050 package's emitter is roughly 3 mm across. Its angular subtense: **34′ at 0.3 m, 21′ at
  0.5 m, 10′ at 1 m, 5′ at 2 m.** So at anything past arm's length this LED is *inside* the
  small-field regime and blue-vs-yellow becomes unreliable. That is a direct argument against
  using blue and yellow as two adjacent classes.

- **Absolute identification, not discrimination.** Per §A.5, ~12 hues is the ideal-conditions
  ceiling; a lone point source with no reference is far below it.

- **Channel imbalance.** Blue is the weakest channel by a wide margin (§B.1). A blue class at code
  5 is putting out roughly 4–8 mcd, against 22–28 mcd for green — it will read as dimmer as well
  as as a different hue, which is a confound if brightness is also carrying meaning ("brightness
  follows speed").

**Working conclusion: 3–5 classes.** Red, green, blue and white are safe. Amber/yellow is
achievable but must be authored directly at low codes (e.g. `(5,3,0)`), never derived by scaling,
and must not be adjacent to blue in the vocabulary.

### B.6 Absolute brightness at 2%

Using the datasheet intensity ranges scaled to code 5/255:

| | at code 5 |
| --- | --- |
| Red | 10.8–13.7 mcd |
| Green | 21.6–27.5 mcd |
| Blue | 3.9–7.8 mcd |
| White (5,5,5) | 36–49 mcd (SparkFun rev.) / 24–26 mcd (Adafruit rev.) |

These are *upper* bounds: they assume linear scaling, which §B.2 shows is false at low codes on
every revision, and false by a lot on the V5. Real output at code 5 will be below these figures.

For context, an ordinary panel indicator LED is tens of mcd. So 2% is a *reasonable* indicator
brightness, not a token glow — the problem with 2% is not that it is too dim to see, it is that it
leaves only four usable codes per channel to encode anything with.

### B.7 Is gamma correction needed?

**Not in the way the ticket's phrasing implies, and applying it naively would break the LED.**

Perceived lightness relates to linear luminance by the CIE L\* function, which is a cube root
above Y = 0.008856 and *linear* below it. Working through the codes:

| Code | Y (linear duty) | CIE L\* | ΔL\* from previous |
| --- | --- | --- | --- |
| 0 | 0.0000 | 0.00 | — |
| 1 | 0.0039 | 3.54 | 3.54 |
| 2 | 0.0078 | 7.08 | 3.54 |
| 3 | 0.0118 | 10.38 | 3.30 |
| 4 | 0.0157 | 13.04 | 2.66 |
| 5 | 0.0196 | 15.28 | 2.24 |

Three things follow.

1. **The bottom of the range is already nearly perceptually linear.** Codes 0–2 are inside L\*'s
   linear segment, and 3–5 have only just entered the cube-root region. Gamma correction exists to
   fix the compression of a *wide* ramp; there is no compression to fix in a six-code ramp at the
   floor.
2. **Applying gamma after the 2% scale annihilates the output.** `255·(c/255)^2.2` maps codes 1
   through 8 all to **0**. If a "brightness follows speed" feature computes a 0–255 perceptual
   ramp, gamma-corrects it, and *then* multiplies by 0.02, the LED goes dark. Order is
   load-bearing: any perceptual mapping must be applied in a wider domain and quantised exactly
   once, at the driver.
3. **The ramp has about four steps, not 256.** Each ΔL\* above is 2.2–3.5, and a just-noticeable
   lightness difference is on the order of ΔL\* ≈ 1. So the steps are individually visible — a 2%
   brightness ramp is a visible *staircase*, not a smooth fade, and it spans only L\* 0–15 of 100.

**If a smooth, wide brightness ramp is actually wanted, the fix is not gamma — it is headroom or
dithering.** Either raise the ceiling well above 2% so there are codes to work with, or use
temporal dithering: refresh the pixel faster than flicker fusion and alternate between adjacent
codes to synthesise intermediate levels. This is exactly what FastLED does and why: it exists "to
preserve high quality color and accurate light output when the master brightness control is turned
down", it has no effect at full brightness, and its quality depends on how often the LED is
refreshed. Without it "the library reverts back to 'flooring' integer values" — which is precisely
what `Rgb::scaled` does today.
Source: [FastLED wiki, Temporal
Dithering](https://github.com/FastLED/FastLED/wiki/FastLED-Temporal-Dithering).

Dithering is feasible here — the render loop already exists and the RMT driver is async — but it
is a real cost and should be a deliberate decision, not an implementation detail.

### B.8 Diffusion on this board

**Not established.** Neither this repo nor the vendored `reference/OSSM-hardware` and
`reference/ossm-rs` checkouts (both empty in this working tree) contain any statement about a
diffuser, light pipe, or enclosure window over the GPIO38 pixel.

What it would change if there is none: a bare 5050 presents three spatially separate dies, so at
close range the "colour" is three coloured points rather than a mixed hue, and the mix ratio
shifts with viewing angle. This interacts badly with §B.5 — a hue authored as `(5,3,0)` may read
as a red point beside a dimmer green point rather than as amber.

Resolving it needs the bench, not more reading. The three measurements worth taking, in one
sitting:

1. Sweep one channel through codes 0–10 and record the first code that visibly lights. Confirms
   whether this board's part is a V5 and pins the real floor.
2. Photograph the pixel at 0.3 m and 1 m showing `(5,3,0)`, `(5,5,0)`, `(0,0,5)`. Confirms whether
   the dies mix and whether amber survives.
3. Show each candidate class colour to someone who has not seen the list and ask them to name it.
   That, not a chromaticity calculation, is the test that matters for absolute identification.

---

## Open questions this research does not close

- Whether the fitted part on `ossm-alt` is a V5. The firmware cannot tell; only the bench can.
- Whether 2% is the right ceiling at all. Every constraint above is a consequence of that number,
  and #2 already lists brightness policy as unspecified. Raising it to ~8–10% would restore a
  usable palette and a usable ramp at once; the counter-argument is the bedside context, which
  this research cannot weigh.
- Whether blink counts should be encoded per fault code or per fault *class* with the colour
  carrying the class. §A.1 shows both are in the field, and Dell notably does not use colour for
  class.
