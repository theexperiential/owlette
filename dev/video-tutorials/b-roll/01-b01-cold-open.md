# ep01 b01 — cold open b-roll brief

Three shots, ~4.5s each, cut in order under the b01 narration (14s):

> *three in the morning. your installation isn't running. nobody's on site, the machine
> driving your show crashed hours ago, and the display's been frozen ever since — you
> won't find out until someone walks in at opening.*

The beat's whole job is recognition: whoever is watching should see **their own**
installation. So it is not one venue, it is three — an exhibit, a lobby, a control room —
and none of them contains a person.

## Two rules that decide whether this works

**1. Generate the ROOM. Composite the SCREEN.** Image models render UI text as
garbled pseudo-glyphs, and a fake-looking Windows dialog is exactly the detail an
operator's eye lands on. Ask for a screen that is *dark, or frozen on an abstract
stalled image* — then drop the real frozen frame and the real error dialog onto it in
Resolve (corner-pin the four screen corners; the screens below are deliberately
described flat-on or near-flat to make that trivial). If you'd rather not composite,
keep every screen far enough away that no text would be legible anyway.

**2. Grade the three as one shot.** They only feel like a montage if they share a
palette. Target: cool blue-grey ambient (~5600K, heavily underexposed), one sickly
screen glow as the sole practical light source, deep crushed blacks, faint haze so the
light has shape. If a generation comes back warm or evenly lit, reroll it — you cannot
grade "evenly lit" back into "3am".

---

## Shot 1 — the exhibit

> A dark museum exhibition hall at three in the morning, completely empty of people. A
> single freestanding interactive kiosk stands off-center, its screen frozen and casting
> a pale cyan glow across a polished concrete floor. Display plinths and a large hanging
> artwork recede into blackness behind it. A faint green emergency-exit sign glows far in
> the background. Volumetric haze in the air, long soft shadows, deep crushed blacks.
> Shot on 35mm, f/2.0, shallow depth of field, slow dolly-in. Cinematic, desaturated cool
> palette, the screen is the only light source. Nobody present.

## Shot 2 — the lobby

> An empty corporate lobby at three in the morning, floor-to-ceiling glass walls with a
> quiet city skyline beyond. A large LED video wall dominates the far wall, stalled on a
> single static frame, its light spilling across a polished marble floor and an
> unattended reception desk. Blue-hour ambient, no interior lights on, the wall is the
> only illumination. Wide anamorphic framing, slow push-in, faint atmospheric haze,
> reflections on the floor. Cinematic, cool desaturated palette. No people.

## Shot 3 — the control room

> A darkened audiovisual control room at three in the morning, unoccupied. A rack of
> media servers along one wall shows small amber and green status LEDs. Above the desk,
> three monitors: two completely black, the third frozen on a stalled image. Neat cable
> runs, acoustic foam panels, an empty operator chair pushed back. Cold blue ambient
> light, warm LED accents from the rack, deep shadow. Shallow depth of field, slow dolly
> past the rack toward the monitors. Cinematic, moody, no people.

---

## Ask for / avoid

**Ask for:** 16:9, 1920×1080 or larger · slow camera move (dolly-in or push-in) · 4–6s
per clip · no cuts within a clip · 24 or 30fps is fine, the timeline conforms it.

**Avoid:** people or silhouettes · any legible text, logo, watermark or brand · warm
domestic lighting · lens flares and light streaks · clean evenly-lit "product shot"
rendering · a screen bright enough to be the subject rather than the accent.

**Reroll if:** the room reads as daytime, a person appears in reflection, the screen
shows invented UI, or the three shots don't share a palette.

## Landing it in the cut

Files go in this folder as `01-b01-shot1.mp4` … `shot3.mp4`. They are the only beat in
the series that is not machine-captured, so they will never appear in
`vet-recordings.py` (which audits captured takes) and the Resolve conform will keep
listing b01 as a V1 gap until they are cut in by hand.
