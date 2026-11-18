#!/usr/bin/env python3
"""Small, dependency free helper to read and edit the resume .docx (standard library only).

  python docx-tool.py dump  resume.docx                      list every paragraph: index, run count, text
  python docx-tool.py apply resume.docx edits.json out.docx  write a tailored copy

edits.json:
  {
    "edits":  { "3": "new text for paragraph 3", "5#1": "new text for run 1 of paragraph 5" },
    "order":  [ { "block": [19, 23], "order": [20, 19, 21, 22, 23] } ],
    "delete": [ 29 ]
  }
- "i" replaces the text of the LAST run of paragraph i (bullets and the summary have one run).
- "i#r" replaces run r (0 based) of paragraph i (skills lines: run 0 is the bold label, run 1 the text).
- "order" reorders a contiguous block of paragraphs (original indexes, first to last).
- "delete" removes paragraphs by original index.
Formatting (fonts, bullets, tabs) is untouched because only the text inside <w:t> is replaced.
Run python facts-guard.py on the result before using it.
"""
import json, re, sys, zipfile
from xml.sax.saxutils import escape

PARA = re.compile(r'<w:p[ >].*?</w:p>', re.S)
RUN = re.compile(r'<w:r[ >].*?</w:r>', re.S)
TEXT = re.compile(r'(<w:t(?: [^>]*)?>)([^<]*)(</w:t>)')


def load(path):
    z = zipfile.ZipFile(path)
    return z, z.read('word/document.xml').decode('utf-8')


def split_body(xml):
    start = xml.index('<w:body>') + len('<w:body>')
    paras = list(PARA.finditer(xml, start))
    return start, paras


def run_text(run):
    return ''.join(re.findall(r'<w:t(?: [^>]*)?>([^<]*)</w:t>', run))


def unescape(s):
    return s.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&')


def dump(path):
    z, xml = load(path)
    _, paras = split_body(xml)
    for i, m in enumerate(paras):
        runs = RUN.findall(m.group(0))
        texts = [unescape(run_text(r)) for r in runs]
        bullet = 'bullet' if '<w:numPr>' in m.group(0) else ''
        print(f'{i:2d} | runs={len(runs)} {bullet:6s} | ' + ' || '.join(t for t in texts))


def set_run_text(run, new):
    ts = list(TEXT.finditer(run))
    if not ts:
        raise SystemExit('run has no text element')
    first = ts[0]
    out = run[:first.start()] + first.group(1) + escape(new) + first.group(3) + run[first.end():]
    # blank any further <w:t> in the same run
    rest = list(TEXT.finditer(out))
    for t in reversed(rest[1:]):
        out = out[:t.start()] + t.group(1) + t.group(3) + out[t.end():]
    return out


def apply(path, edits_path, out_path):
    z, xml = load(path)
    start, paras = split_body(xml)
    spec = json.load(open(edits_path, encoding='utf-8'))
    blocks = [m.group(0) for m in paras]
    for key, new in spec.get('edits', {}).items():
        pi, _, ri = str(key).partition('#')
        pi = int(pi)
        runs = RUN.findall(blocks[pi])
        ri = int(ri) if ri != '' else len(runs) - 1
        old_run = runs[ri]
        blocks[pi] = blocks[pi].replace(old_run, set_run_text(old_run, new), 1)
    delete = set(spec.get('delete', []))
    order = list(range(len(blocks)))
    for o in spec.get('order', []):
        a, b = o['block']
        assert sorted(o['order']) == list(range(a, b + 1)), 'order must be a permutation of the block'
        order[a:b + 1] = o['order']
    new_paras = [blocks[i] for i in order if i not in delete]
    first, last = paras[0].start(), paras[-1].end()
    new_xml = xml[:first] + ''.join(new_paras) + xml[last:]
    # paragraphs were contiguous? make sure nothing but paragraphs sat between them (tables or section breaks would be lost)
    between = ''.join(xml[paras[k].end():paras[k + 1].start()] for k in range(len(paras) - 1))
    assert between.strip() == '', 'document has non paragraph content between paragraphs; not supported'
    zin = zipfile.ZipFile(path)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == 'word/document.xml':
                data = new_xml.encode('utf-8')
            zout.writestr(item, data)
    print('wrote', out_path)


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'dump':
        dump(sys.argv[2])
    elif len(sys.argv) == 5 and sys.argv[1] == 'apply':
        apply(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(__doc__)
        sys.exit(2)
