# Football tracking evaluation and training data

## Current evidence

The seed corpus contains production observations from two uploads. These are
regression cases already used during development, **not unseen test matches**.
AI event labels, AI approvals and detector outputs are unverified claims. No
detector has been trained on these cases and no broad accuracy claim is valid.

`reports/` contains small, reproducible per-scene diagnostic records, not video
files. Media and full tracking checkpoints remain in the private workspace.
Each case has a source-content ID, exact source interval, detector/review
versions, failures, repair history and annotation status. Every new tracking
run writes `tracking/evaluation-report.json` into its durable checkpoint.

## Repeatable collection

The standard `npm test` command includes the shared football recovery and
evaluation regressions. Run them directly with `npm run test:football`.
The native detector regressions are included by `npm run test:tracking`.

    node tools/football-evaluation.mjs collect JOB_JSON TRACKING_JSON evaluation/football/reports
    node tools/football-evaluation.mjs summary evaluation/football/reports

Record every failure, including false approvals and event-label conflicts.
Keep the earlier report when comparing a new tracker/model version; use
separate report directories for baseline and candidate results.

## Human reference labels

Review source and actual 9:16 crop side by side. Record the final contact,
flight, payoff, true event, relevant player identity and whether the crop
should pass. Mark the ball's visible bounding box on sampled source frames;
mark occluded/out-of-frame frames explicitly without guessing coordinates.
Include hard negatives: boots, markings, spare balls, advertising and crowd.
Do not turn a model's confident description into a reference annotation.

Annotation JSON is an array of records:

```json
[
  {
    "caseId": "ID_FROM_REPORT",
    "verifiedByHuman": true,
    "reviewer": "REVIEWER_ID",
    "matchGroup": "MATCH_ID",
    "split": "regression",
    "cropShouldPass": false,
    "eventType": "save",
    "categories": ["save", "occlusion"],
    "notes": "Describe the observed failure and its exact time."
  }
]
```

Train, validation and test partitions must use different **matches**, not
random frames from the same match. All known failures remain in a regression
suite. Add genuinely unseen matches for the final comparison.

## Coverage and release gate

Expand beyond the initial two uploads: goals, misses, saves, headers, crosses,
rebounds, penalty awards and kicks, fouls/decisions, reactions, replays,
occlusion, small/fast balls, hard pans, zooms, night/low-light footage and
compression. Record categories from inspected footage, not filenames.

The initial broad release gate requires at least 50 human-verified cases from
10 different matches, coverage of the listed critical categories, and no
false approvals or regressions in that labelled set. This is a minimum gate;
it does not guarantee all possible recordings. Report missing categories and
unknown accuracy explicitly. Larger and more diverse held-out sets are needed
before making stronger reliability claims.

## Training decision

Train/fine-tune the football detector only after the labelled data demonstrates
systematic ball-detection errors. Compare its visible-ball precision/recall and
hard-negative errors on held-out matches. Separately measure identity switches,
ball loss, setup/contact/payoff visibility, camera motion and false crop
approvals. Timing validation and recovery bugs need code fixes even if detector
training improves recall. Evaluate a candidate against the current detector on
the same held-out scenes before deployment; preserve the previous weights and
model/data hashes for rollback.

SoccerNet supplies a relevant external benchmark, subject to its access and
usage terms. It does not replace testing the app's own 9:16 output:
https://www.soccer-net.org/tasks/tracking
https://openaccess.thecvf.com/content/CVPR2022W/CVSports/papers/Cioppa_SoccerNet-Tracking_Multiple_Object_Tracking_Dataset_and_Benchmark_in_Soccer_Videos_CVPRW_2022_paper.pdf

Gemini's video documentation notes that fast action can lose detail under
sparse sampling. Our review requests explicitly set frame rate and resolution;
those settings still need evaluation against labelled frames:
https://ai.google.dev/gemini-api/docs/video-understanding
