"""Wait for this collection, then independently audit and atomically export."""
import json, subprocess, sys, time
from pathlib import Path

ROOT=Path(__file__).resolve().parent
def main():
    while True:
        progress=json.loads((ROOT/'collection_progress.json').read_text())
        if progress['finished']:
            if progress['errors'] or progress['blocked'] or progress['totalCompleted']!=progress['targetCids']:
                raise SystemExit('Collection incomplete; final snapshot not declared ready')
            break
        time.sleep(15)
    for script in ['audit_raw_details.py','export_complete.py']:
        subprocess.run([sys.executable,'-u',str(ROOT/script)],cwd=ROOT,check=True)
    manifest=json.loads((ROOT/'snapshot_manifest.json').read_text())
    if not manifest['allValidationChecksPass']:raise SystemExit('Final validation failed; inspect validation_report.json')
    temporary=ROOT/'READY.json.tmp';temporary.write_text(json.dumps(manifest,ensure_ascii=False,indent=2));temporary.replace(ROOT/'READY.json')
    print('READY: all source audits and final snapshot checks pass',flush=True)

if __name__=='__main__':main()
