"""A failed product must not block verified prices or lose its previous trades."""
import copy
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock
from scripts import collect_kream_promos as collector
from scripts import import_kream_local as importer
from scripts import run_kream_local as runner


class PartialCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base=Path(self.temporary.name)/'baseline'
        self.candidate=Path(self.temporary.name)/'candidate'
        source=Path(__file__).resolve().parents[1]
        for root in (self.base,self.candidate):
            for name in importer.FILES:
                path=root/name
                path.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(source/name,path)
        self.original={name:(self.base/name).read_bytes() for name in importer.FILES}
        self.manifest=collector.validate_bundle(self.base)
        self.now=datetime.now(collector.KST)
        self.attempted=(self.now-timedelta(minutes=2)).isoformat()

    def history(self,ident):
        data=collector.unpack_history(json.loads(self.original['data/korean-promos/'+ident+'.json']))
        data.update(snapshot_started_at=self.attempted,last_observed_at=(self.now-timedelta(minutes=1)).isoformat(),target_count=len(data['rows']))
        return data

    def publish(self):
        staged={ident:self.history(ident) for ident in collector.IDS if ident not in ('893073','998016')}
        data=staged['1096144']
        data['rows'].insert(0,copy.deepcopy(data['rows'][0]))
        data['collected_count']+=1
        data['counts_by_exact_option'][data['rows'][0]['option']]+=1
        data['target_count']+=1
        for index,row in enumerate(data['rows']):row['source_rank']=index
        collector.publish_partial_generation(self.candidate,self.manifest,staged,self.attempted)
        return staged

    def test_partial_keeps_failed_files_and_last_full_success_exactly(self):
        self.publish()
        checked=importer.validate_candidate(self.base,self.candidate,now=self.now)
        self.assertEqual(checked['last_success_at'],self.manifest['last_success_at'])
        self.assertEqual(checked['collected_trade_count'],self.manifest['collected_trade_count']+1)
        self.assertEqual(checked['refresh']['status'],'partial')
        self.assertEqual(checked['refresh']['failed_product_ids'],['893073','998016'])
        for ident in ('893073','998016'):
            name='data/korean-promos/'+ident+'.json'
            self.assertEqual(self.original[name],(self.candidate/name).read_bytes())

    def test_different_failed_history_is_rejected_even_if_bundle_is_consistent(self):
        self.publish()
        manifest=json.loads((self.candidate/importer.FILES[0]).read_bytes())
        card=next(card for card in manifest['cards'] if card['id']=='893073')
        name=card['file'].lstrip('/')
        raw=(self.candidate/name).read_bytes()+b' '
        (self.candidate/name).write_bytes(raw)
        card['version']=hashlib.sha256(raw).hexdigest()[:16]
        (self.candidate/importer.FILES[0]).write_bytes(collector.encoded(manifest))
        with self.assertRaises(ValueError):importer.validate_candidate(self.base,self.candidate,now=self.now)

    def test_partial_cannot_claim_a_new_full_success(self):
        self.publish()
        for name in importer.FILES[:2]:
            data=json.loads((self.candidate/name).read_bytes())
            data['last_success_at']=self.now.isoformat()
            (self.candidate/name).write_bytes(collector.encoded(data))
        with self.assertRaises(ValueError):importer.validate_candidate(self.base,self.candidate,now=self.now)

    def test_partial_cannot_hide_a_duplicate_trade_removal(self):
        staged={ident:self.history(ident) for ident in collector.IDS if ident not in ('893073','998016')}
        data=staged['1096144']
        data['rows'].pop()
        data['collected_count']-=1
        data['counts_by_exact_option']=dict(collector.Counter(row['option'] for row in data['rows']))
        with self.assertRaises(ValueError):collector.publish_partial_generation(self.candidate,self.manifest,staged,self.attempted)

    def test_zero_success_is_not_publishable(self):
        with self.assertRaises(ValueError):collector.publish_partial_generation(self.candidate,self.manifest,{},self.attempted)

    def test_complete_success_clears_partial_status(self):
        self.publish()
        manifest=collector.validate_bundle(self.candidate)
        staged={card['id']:collector.unpack_history(json.loads((self.candidate/card['file'].lstrip('/')).read_bytes())) for card in manifest['cards']}
        collector.publish_generation(self.candidate,manifest,staged,self.attempted)
        checked=collector.validate_bundle(self.candidate)
        self.assertEqual(checked['refresh']['status'],'success')
        self.assertFalse(any(key in checked['refresh'] for key in collector.PARTIAL_FIELDS))

    def test_local_runner_continues_other_products_after_a_source_mismatch(self):
        calls=[]
        def collect(page,card,old,**kwargs):
            calls.append(card['id'])
            if card['id']=='893073':raise collector.CollectionError('historical_rows_missing','Fixed public error')
            return self.history(card['id'])
        with mock.patch.object(collector,'collect',side_effect=collect):
            result=runner.collect_generation(mock.Mock(pages=[object()]),self.candidate,lambda *a,**k:None)
        self.assertEqual(calls,list(collector.IDS))
        self.assertEqual(result['refresh']['failed_product_ids'],['893073'])


if __name__=='__main__':unittest.main()
