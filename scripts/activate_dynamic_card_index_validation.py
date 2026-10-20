"""Bind a successful independent raw-source proof to a candidate calculation.

This local promotion does not deploy or certify unit prices/market coverage.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path


def promote(directory):
    directory = Path(directory)
    data_raw = (directory / 'market-price-index.json').read_bytes()
    payload = json.loads(data_raw)
    proof_path = directory / 'market-price-index-independent-verification.json'
    proof_raw = proof_path.read_bytes()
    proof = json.loads(proof_raw)
    report_path = directory / 'market-price-index-validation.json'
    report = json.loads(report_path.read_bytes())
    sha = hashlib.sha256(data_raw).hexdigest()
    if (payload['methodology']['id'] != 'dynamic-equal-initial-amount-card-basket-v1'
            or proof.get('reportKind') != 'dynamic-card-price-index-independent-verification'
            or proof.get('status') != 'passed' or proof.get('errors') != []
            or proof.get('calculationOnly') is not True or proof.get('marketReady') is not False
            or proof.get('dataSha256') != sha or report.get('dataSha256') != sha):
        raise ValueError('Independent verification does not bind this exact candidate')
    for key in ['inputFingerprints', 'modelStateRef', 'methodPolicy', 'strictFlags']:
        if not payload.get(key) or proof.get(key) != payload[key] or report.get(key) != payload[key]:
            raise ValueError('Independent proof differs from candidate: ' + key)
    if any(value is not False for value in payload['strictFlags'].values()):
        raise ValueError('Unsupported source or market certification')
    if hashlib.sha256((directory / payload['modelStateRef']['file']).read_bytes()).hexdigest() != payload['modelStateRef']['sha256']:
        raise ValueError('Audit model state changed after independent verification')
    report.update(status='passed', independentAudit={
        'file': proof_path.name, 'sha256': hashlib.sha256(proof_raw).hexdigest(),
        'status': 'passed', 'dataSha256': sha, 'checksPassed': proof['checksPassed'],
        'methodId': payload['methodology']['id'],
    }, checksPassed=proof['checksPassed'],
       validationMeaning='Independently reconstructed actual condition prices, past-only admission, fixed virtual quantities, all daily values and neutral membership changes. Not market/unit-price certification.')
    temporary = report_path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(report_path)
    print(json.dumps({'status': 'passed', 'dataSha256': sha, 'checksPassed': proof['checksPassed'],
                      'marketReady': False, 'sourceAsOf': payload['sourceAsOf']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'data')
    promote(parser.parse_args().data_dir)
