# BitSafe evidence reports

Each file here is the report of one run of `scripts/bitsafe-demo.sh` on a real LocalNet, named `<YYYY-MM-DDTHHMM>.md` (UTC). They are the recorded test results for specs.md N8 and S5, and `docs/bitsafe.md` links the newest one.

Rules:

- **Only reports from real LocalNet runs belong here.** The script's `--dry-run` writes no report, and runs against stub servers (used while writing the script) are deleted. A report is never edited by hand: if a claim failed, fix the cause, run the script again and commit the new report in place of the old one (the fix and the failed run are in the commit history).
- A report starts with a summary table: each claim, pass or fail, and a link to its evidence further down (the exact commands, the trimmed API responses, the node commands and their output).
- If the run was stopped early, the report says so and lists the claims not reached as `NOT RUN`.

Run it and commit the result as described in [docs/verification.md](../verification.md#bitsafe-evidence-owners-machine).

Latest: [2026-10-08T2000.md](2026-10-08T2000.md), all 11 claims pass.
