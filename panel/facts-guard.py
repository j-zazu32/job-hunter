#!/usr/bin/env python3
"""Guard against invented experience. Standard library only.

  python facts-guard.py original.docx tailored.docx [extra facts files...]

Words are checked against the original resume first. Words found only in PROMPT.md, profile.json or extra files are printed as CONFIRM notes.
Every word in the tailored resume that is NOT in that vocabulary AND looks like a tool, certification, acronym,
proper noun or number is reported. Plain new words (verbs, connectors) are allowed because rewording is the point.
Exit code 0 = nothing suspicious, 1 = review needed. The tailored resume must not be used until each flagged word is
either removed or shown to be a real fact from the candidate's own files.
"""
import os, re, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9+#./&'-]*|\d[\d,.%+]*")


def docx_text(path):
    xml = zipfile.ZipFile(path).read('word/document.xml').decode('utf-8')
    paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.S)
    out = []
    for p in paras:
        t = ''.join(re.findall(r'<w:t(?: [^>]*)?>([^<]*)</w:t>', p))
        out.append(t.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>'))
    return '\n'.join(out)


def norm(tok):
    return tok.lower().strip(".,;:'-/&").replace('’', "'")


def vocab(text):
    s = set()
    for t in TOKEN.findall(text.replace('’', "'")):
        n = norm(t)
        s.add(n)
        for part in re.split(r"[/.\-&']", n):
            if part:
                s.add(part)
    return s


def suspicious(tok, sentence_start):
    if re.search(r'\d', tok):
        return 'number'
    letters = re.sub(r'[^A-Za-z]', '', tok)
    if len(letters) >= 2 and letters.isupper():
        return 'acronym'
    if any(c.isupper() for c in tok[1:]):
        return 'tool name'
    if tok[0].isupper() and not sentence_start:
        return 'proper noun'
    return None


def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(2)
    orig, tailored, extras = sys.argv[1], sys.argv[2], sys.argv[3:]
    resume_text = docx_text(orig)
    confirmed_text = ''
    # the "Confirmed facts" section of PROMPT.md (any heading that starts with "## Confirmed facts") counts as true, like the resume itself
    prompt_md = os.path.join(ROOT, 'PROMPT.md')
    if os.path.exists(prompt_md):
        md = open(prompt_md, encoding='utf-8', errors='ignore').read()
        sec = re.search(r'## Confirmed facts[^\n]*(.*?)(?=\n## )', md, re.S)
        if sec:
            resume_text += '\n' + sec.group(1)
            confirmed_text = sec.group(1)
    prompt_text = ''
    for f in [os.path.join(ROOT, 'PROMPT.md'), os.path.join(ROOT, 'profile.json')] + extras:
        if os.path.exists(f):
            prompt_text += '\n' + open(f, encoding='utf-8', errors='ignore').read()
    in_resume = vocab(resume_text)
    in_files = vocab(prompt_text)
    flagged, notes = {}, {}
    for line in docx_text(tailored).split('\n'):
        prev_end = True
        for m in TOKEN.finditer(line.replace('’', "'")):
            tok = m.group(0)
            n = norm(tok)
            parts = [p for p in re.split(r"[/.\-&']", n) if p]
            if n in in_resume or (parts and all(p in in_resume for p in parts)):
                pass
            else:
                why = suspicious(tok.strip(".,;:"), prev_end)
                if why:
                    clean = tok.strip('.,;:')
                    if n in in_files or (parts and all(p in in_files for p in parts)):
                        notes.setdefault(clean, why)      # only in PROMPT.md or profile.json, not in the resume
                    else:
                        flagged.setdefault(clean, why)
            # the NEXT word starts a sentence if this token ends with a period or colon, or a separator bar follows
            prev_end = tok.endswith(('.', ':', ';')) or line[m.end():m.end() + 3].strip().startswith('|')
    # bare numbers that exist in the original but changed meaning are not caught; compare numbers with context too
    orig_nums = [x.rstrip('.,') for x in re.findall(r'\d[\d,.%+]*', docx_text(orig) + '\n' + confirmed_text)]
    new_nums = [x.rstrip('.,') for x in re.findall(r'\d[\d,.%+]*', docx_text(tailored))]
    changed = sorted(set(new_nums) - set(orig_nums))
    if notes:
        print('CONFIRM: in the tailored resume but not in the original resume (they appear in PROMPT.md or profile.json). Each must be a real fact about the candidate:')
        for tok, why in sorted(notes.items()):
            print(f'  - {tok}  ({why})')
    if flagged or changed:
        print('REVIEW NEEDED: words or numbers in the tailored resume that are not in your resume, PROMPT.md or profile.json')
        for tok, why in sorted(flagged.items()):
            print(f'  - {tok}  ({why})')
        for n in changed:
            print(f'  - number {n} is new')
        sys.exit(1)
    print('facts guard: OK, nothing new that is missing from your files' + (' (see CONFIRM above)' if notes else ''))


if __name__ == '__main__':
    main()
