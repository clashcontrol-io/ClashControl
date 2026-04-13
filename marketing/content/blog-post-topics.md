# Blog Post Topic Setups
Deep-dive articles for clashcontrol.io blog / dev.to / LinkedIn Articles.
Each setup includes angle, outline, target keyword, and why it works.

---

## BP-02 — The Hidden Cost of a Clash Found on Site

**Primary keyword:** cost of BIM clash on site
**Secondary:** clash detection ROI, BIM coordination value
**Length:** 1,200–1,500 words
**Angle:** Make the financial case for coordination quantitatively. This is the post that gets forwarded to project directors and clients who ask "why do we spend money on BIM coordination?"

**Hook:** A single undetected clash — a duct routed through a beam — caused 11 days of programme delay on a hospital project. Here's the full cost breakdown.

**Outline:**
1. The moment the clash is found on site (scene-setting)
2. The direct costs: rework labour, material waste, crane time
3. The indirect costs: delay to following trades, variation disputes, professional indemnity implications
4. The comparison: what the same clash costs to resolve in the model (15 minutes of a coordinator's time)
5. The 10–20× figure explained — where it comes from and why it understates the real cost
6. What this means for how you allocate coordination budget
7. How ClashControl changes the economics (free tool = zero tool cost, only coordination time)

**Why it works for SEO:** High commercial intent — project managers and clients Google "cost of clashes on site" when they're building a business case. Ranks for long-tail queries around BIM ROI.

---

## BP-03 — Open Source vs Proprietary BIM Tools: An Honest Comparison

**Primary keyword:** open source BIM tools
**Secondary:** free BIM software, Navisworks alternative, open source IFC
**Length:** 1,500–2,000 words
**Angle:** Not a takedown of Autodesk — a fair-handed analysis of where open source genuinely competes and where it doesn't. This credibility makes it more shareable.

**Hook:** The open vs proprietary debate in AEC software generates more heat than light. Here's an honest breakdown.

**Outline:**
1. What "open source" actually means in a BIM context (free ≠ open source; open source ≠ hobbyist)
2. Where open source BIM tooling is genuinely competitive today: IFC viewers, clash detection, BCF workflows
3. Where proprietary still wins: authoring (Revit), Autodesk ecosystem integration, enterprise support
4. The total cost of ownership comparison — licence fees vs setup/maintenance overhead
5. Case study: a coordination workflow built entirely on open tools (IFC export from Revit + ClashControl + BCF)
6. What to look for when evaluating any BIM tool (open or proprietary)
7. Where the open source BIM ecosystem is heading

**Why it works for SEO:** "Open source BIM tools" is a growing query as firms look to cut software overhead. The balanced framing drives more shares and backlinks than a pure advocacy piece.

---

## BP-04 — The Complete Guide to BCF: What It Is, How to Use It, and Why It Matters

**Primary keyword:** BCF BIM file format
**Secondary:** BCF export Revit, BIM collaboration format, BCF 2.1
**Length:** 1,800–2,200 words
**Angle:** The definitive explainer. BCF is 15 years old and still misunderstood by half the industry. Own this query.

**Hook:** BCF has been around since 2010. Most coordinators have heard of it. Fewer than half use it correctly. Here's everything you need to know.

**Outline:**
1. What BCF is (not a model format — an issue format)
2. What a BCF file actually contains: viewpoints, issues, snapshots, metadata
3. BCF versions: 2.0, 2.1, 3.0 — what changed and what's supported where
4. The platforms that support BCF (exhaustive list with notes on implementation quality)
5. Step-by-step: exporting BCF from ClashControl, importing into Revit, importing into BIMcollab
6. BCF vs proprietary issue tracking: when to use each
7. Common BCF mistakes (broken viewpoints, missing global IDs, status not updating)
8. The future of BCF: BCF 3.0 and what it enables

**Why it works for SEO:** Evergreen reference content. People searching "BCF BIM" or "BCF export Revit" are doing technical research — high-value audience, low existing content quality on this query.

---

## BP-05 — IFC Clash Detection: A Technical Deep Dive

**Primary keyword:** IFC clash detection how it works
**Secondary:** OBB collision detection BIM, hard clash vs soft clash IFC
**Length:** 1,500–2,000 words
**Angle:** Go technical. Explain the geometry. This earns credibility with the actual BIM coordinators and developers who will share it — and it's content no vendor publishes because it demystifies their product.

**Hook:** Every clash detection tool says it uses "intelligent clash detection." Here's what that actually means geometrically.

**Outline:**
1. What clash detection is operating on (IFC geometry — meshes, solids, swept areas)
2. Hard clashes: intersection detection using Oriented Bounding Boxes (OBBs) — why OBBs not AABBs
3. Why OBBs are approximate and what that means for accuracy
4. Soft clashes: closest-point queries and clearance thresholds
5. The false positive problem: why OBB detection produces near-misses, and what tools do about it
6. Exact mesh intersection (the local Python engine addon) — when you need it and when you don't
7. How element pairs are selected (discipline pairs, type filters, cross-model vs intra-model)
8. Performance considerations: why large federated models are slow and what helps
9. What the output means — how to read clash severity, penetration depth, closest point

**Why it works for SEO:** Technical SEO — questions like "how does clash detection work" have almost no good existing answers. Ranks for developer and advanced coordinator queries. Gets linked to from Stack Overflow and BIM forums.

---

## BP-06 — MEP Coordination: A Step-by-Step Workflow for Clash-Free Services

**Primary keyword:** MEP BIM coordination workflow
**Secondary:** MEP clash detection, MEP vs structure clashes, MEP IFC coordination
**Length:** 1,200–1,500 words
**Angle:** Practical workflow guide aimed at MEP engineers and coordinators. This is the most searched-for content in BIM coordination — how to actually do it.

**Hook:** MEP vs structure produces more clashes than any other discipline pair. Here's a coordination workflow that reduces them before detection even runs.

**Outline:**
1. Why MEP coordination is the hardest part of BIM (sequencing, density, multi-trade conflicts)
2. Setting up your IFC exports correctly for MEP coordination (what properties matter, what geometry level)
3. The model quality checklist before you run detection
4. Configuring MEP vs structure clash rules: clearances for different service types, what threshold to use
5. Interpreting MEP clash results: which clashes are real, which are false positives, what to prioritise
6. The walk-mode review for plant rooms and ceiling plenums
7. Writing a BCF report that MEP contractors can actually act on
8. Re-running after model updates: keeping the coordination current

**Why it works for SEO:** "MEP BIM coordination" is a high-volume, high-intent search. MEP engineers search for practical guidance, not vendor marketing.

---

## BP-07 — How to Set Up BIM Coordination for a Small Firm (Without Enterprise Licensing)

**Primary keyword:** BIM coordination small firm
**Secondary:** free BIM coordination tools, BIM coordination without Navisworks, small architecture firm BIM
**Length:** 1,000–1,400 words
**Angle:** Direct answer to the most common objection: "we're too small for BIM coordination." No — you're too small for the enterprise tools. The workflow itself scales to any project size.

**Hook:** Three-person architecture studio. No Navisworks licence. Currently doing coordination via PDF markups and hoping for the best. Here's how to fix that in an afternoon.

**Outline:**
1. The small firm coordination problem (enterprise tools aren't viable, so nothing gets done)
2. What a minimum viable coordination workflow looks like
3. The tool stack: Revit/ArchiCAD IFC export + ClashControl + BCF + email
4. Setting up your first coordination run: model setup, clash rules, thresholds
5. What to do with the results: triage, assign, resolve, re-run
6. The time investment: realistic expectations for a small team
7. When you've outgrown this workflow and what comes next

**Why it works for SEO:** "BIM coordination small firm" and "BIM coordination without Navisworks" are underserved queries with clear commercial intent. This is the post that converts readers into users.

---

## BP-08 — What Is IDS (Information Delivery Specification) and Why Does It Matter?

**Primary keyword:** IDS BIM information delivery specification
**Secondary:** IDS IFC validation, buildingSMART IDS, model validation BIM
**Length:** 1,000–1,200 words
**Angle:** IDS is new enough that almost no accessible content exists. Own this keyword early.

**Hook:** The buildingSMART IDS standard promises to make BIM model validation systematic rather than manual. Here's what it is, how it works, and how to use it today.

**Outline:**
1. The model quality problem IDS solves (manual checking, inconsistent enforcement)
2. What IDS actually is: XML schema for defining model requirements
3. What an IDS file contains: applicability, requirements, property checks
4. How to create an IDS file (buildingSMART's IDS authoring tools)
5. How to validate a model against IDS in ClashControl
6. How to export your checks as IDS to share with project teams
7. IDS vs manual BIM Execution Plan compliance checking
8. Where IDS is heading: adoption timeline, software support

**Why it works for SEO:** Near-zero competition on this keyword right now. As IDS adoption grows, early content ranks and stays ranked. Drives referral traffic from buildingSMART community.
