#!/usr/bin/env python3
"""Basic stdlib structure + provenance validator for structured writing reviews.

This deliberately does NOT claim to judge English quality, actual rubric authenticity,
or the accuracy of predicted_score against trained high school teachers.

Usage: python scripts/validate_review.py path/to/review.json
"""
import json
import sys
from pathlib import Path

VALID_TYPES = {'E', 'R', 'U', 'S'}
CONFIDENCE = {'high', 'medium', 'low', 'not_applicable'}
STATUS = {'estimated', 'rough_only', 'not_scored'}


def validate(data):
    errors = []
    def check(condition, message):
        if not condition:
            errors.append(message)
    for field in ['schema_version','genre','rubric','input','assessment','overview','dimensions','issues','upgrade_plan']:
        check(field in data, f'missing field: {field}')
    if errors:
        return errors
    genre, r, inp, a = data['genre'], data['rubric'], data['input'], data['assessment']
    max_score = r.get('max_score')
    check(genre in {'practical','continuation','other'}, 'unsupported genre')
    check(isinstance(max_score, int) and max_score in {15,25}, 'max_score must be 15 or 25')
    check(genre != 'practical' or max_score == 15, 'practical score scale must be 15')
    check(genre != 'continuation' or max_score == 25, 'continuation score scale must be 25')
    check(r.get('authority') in {'provided_for_exam','verified_exam','public_reference','general_reference'}, 'rubric.authority invalid')
    check(inp.get('prompt_status') in {'complete','partial','missing'}, 'prompt_status invalid')
    check(inp.get('source_status') in {'complete','partial','missing','not_applicable'}, 'source_status invalid')
    check(a.get('status') in STATUS, 'assessment.status invalid')
    check(a.get('confidence') in CONFIDENCE, 'assessment.confidence invalid')
    value = a.get('predicted_score')
    rng = a.get('plausible_range')
    if value is not None:
        check(isinstance(value,int) and max_score is not None and 0<=value<=max_score, 'predicted_score exceeds scale')
        check(a.get('status') != 'not_scored', 'not_scored must not have predicted_score')
    if rng is not None:
        check(isinstance(rng,list) and len(rng)==2 and all(isinstance(x,int) for x in rng), 'plausible_range must be two integers')
        if isinstance(rng,list) and len(rng)==2 and all(isinstance(x,int) for x in rng):
            check(0<=rng[0]<=rng[1]<=max_score, 'plausible_range out of bounds')
            if isinstance(value,int):
                check(rng[0]<=value<=rng[1], 'predicted_score not inside plausible_range')
    if inp.get('prompt_status') != 'complete' or (genre=='continuation' and inp.get('source_status') != 'complete'):
        check(a.get('confidence') in {'low','not_applicable'}, 'missing prompt/source cannot be medium/high confidence')
        check(a.get('status') != 'estimated', 'missing prompt/source should use rough_only or not_scored')
    if inp.get('ocr_uncertain'):
        check(a.get('confidence') != 'high', 'OCR uncertainty cannot be high confidence')
    if a.get('status')=='not_scored':
        check(value is None and rng is None, 'not_scored must not contain point or range')
    text = inp.get('student_text','')
    ids = set()
    for i, issue in enumerate(data.get('issues', [])):
        prefix = f'issues[{i}]'
        check(issue.get('label') in VALID_TYPES, f'{prefix}.label invalid')
        check(issue.get('id') not in ids, f'{prefix} duplicate id')
        ids.add(issue.get('id'))
        quote = issue.get('original_quote','')
        # Text string equality required for claims about original student quotes.
        check(isinstance(quote, str) and quote and quote in text, f'{prefix}.original_quote not verbatim in student text')
        if issue.get('label') == 'E':
            check(bool(issue.get('minimal_fix')), f'{prefix}.E must provide minimal_fix')
        if issue.get('label') in {'U','S'}:
            check(not issue.get('minimal_fix'), f'{prefix}.U/S cannot imply mandatory error fix')
    return errors


def main():
    if len(sys.argv)!=2:
        print('usage: validate_review.py review.json', file=sys.stderr)
        return 2
    try:
        data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    except (ValueError,OSError) as e:
        print('invalid JSON/file:', e, file=sys.stderr)
        return 2
    errors = validate(data)
    if errors:
        for e in errors: print('FAIL:', e)
        return 1
    print('PASS: structural validity + quote provenance + score-range consistency')
    return 0

if __name__=='__main__':
    sys.exit(main())
