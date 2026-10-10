"""Stand-in for the eunjeon package (needs a compiler on Windows): MeCab + mecab-ko-dic."""
import MeCab
import mecab_ko_dic


class Mecab:
    def __init__(self):
        path = str(mecab_ko_dic.dictionary_path).replace(chr(92), '/')
        self.tagger = MeCab.Tagger(f'-d "{path}" -r nul')

    def pos(self, text):
        out = []
        for line in self.tagger.parse(text).splitlines():
            if line == 'EOS' or '\t' not in line:
                continue
            surface, feat = line.split('\t', 1)
            out.append((surface, feat.split(',')[0]))
        return out
