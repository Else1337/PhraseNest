import importlib.util
import json
import unittest
from copy import deepcopy
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('review_validator', ROOT/'scripts'/'validate_review.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
BASE = json.loads((ROOT/'schemas'/'sample-review.json').read_text(encoding='utf-8'))

class ReviewValidatorTests(unittest.TestCase):
    def test_valid_sample(self): self.assertEqual(mod.validate(BASE), [])
    def test_score_outside_scale(self):
        d=deepcopy(BASE);d['assessment'].update(status='estimated',predicted_score=18,plausible_range=[12,15]);d['input']['prompt_status']='complete'
        self.assertTrue(mod.validate(d))
    def test_missing_prompt_must_be_low_confidence(self):
        d=deepcopy(BASE);d['assessment']['confidence']='high'
        self.assertTrue(mod.validate(d))
    def test_misquoted_student_original(self):
        d=deepcopy(BASE);d['issues'][0]['original_quote']='Student did not write this.'
        self.assertTrue(mod.validate(d))
    def test_upgrade_is_not_grammar_error(self):
        d=deepcopy(BASE);d['issues'][1]['minimal_fix']='Mandatory arbitrary rewrite'
        self.assertTrue(mod.validate(d))
    def test_duplicate_issue_ids(self):
        d=deepcopy(BASE);d['issues'][1]['id']='e1'
        self.assertTrue(mod.validate(d))
    def test_missing_continuation_source(self):
        d=deepcopy(BASE);d['genre']='continuation';d['rubric']['max_score']=25
        d['input'].update(prompt_status='complete',source_status='missing')
        d['assessment'].update(status='estimated',confidence='high',predicted_score=20,plausible_range=[18,22])
        self.assertTrue(mod.validate(d))

if __name__=='__main__': unittest.main()
