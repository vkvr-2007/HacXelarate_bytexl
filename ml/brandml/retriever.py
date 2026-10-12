"""Search-query expansion and the learned character n-gram retriever.

Collectors return whatever the platform search gives back, which is noisy.
The retriever is a TF-IDF model over character n-grams of skeletonised names
and handles, fitted on the training corpus. At scan time it embeds the brand
(name, aliases, look-alike variants) and every collected candidate, then keeps
the candidates whose cosine similarity to the brand passes a threshold. Only
those go on to the ranker.
"""
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

from .text import handle_key, skeleton, tokens


def retrieval_text(name='', handle='', description=''):
    parts = [skeleton(name), skeleton(handle_key(handle))]
    parts += [skeleton(t) for t in tokens(name)]
    return ' '.join(p for p in parts if p)


def expand_queries(brand: dict, limit=6):
    """Search terms sent to platform search APIs."""
    name = brand.get('name', '').strip()
    queries = [name] + [a for a in brand.get('aliases') or [] if a.strip()]
    compact_name = name.replace(' ', '')
    if ' ' in name:
        queries.append(compact_name)
    for word in (brand.get('keywords') or [])[:2]:
        queries.append(f'{name} {word}')
    queries += [f'{name} support', f'{name} official', f'{name} app']
    seen, out = set(), []
    for q in queries:
        key = q.lower()
        if q and key not in seen:
            seen.add(key)
            out.append(q)
    return out[:limit]


class Retriever:
    def __init__(self, vectorizer=None, threshold=0.18):
        self.vectorizer = vectorizer or TfidfVectorizer(analyzer='char_wb', ngram_range=(2, 4), min_df=1, sublinear_tf=True)
        self.threshold = threshold

    def fit(self, texts):
        self.vectorizer.fit(texts)
        return self

    def brand_vector(self, brand: dict):
        names = [brand.get('name', '')] + list(brand.get('aliases') or [])
        text = ' '.join(retrieval_text(n) for n in names if n)
        return self.vectorizer.transform([text])

    def scores(self, brand: dict, candidates: list):
        if not candidates:
            return np.zeros(0)
        brand_vec = self.brand_vector(brand)
        cand_texts = [retrieval_text(c.get('name', ''), c.get('handle', '')) for c in candidates]
        matrix = self.vectorizer.transform(cand_texts)
        # Rows are L2-normalised by TfidfVectorizer, so the dot product is cosine similarity.
        return (matrix @ brand_vec.T).toarray().ravel()

    def retrieve(self, brand: dict, candidates: list, top_k=200):
        """Return (candidate, similarity) pairs above the threshold, best first."""
        sims = self.scores(brand, candidates)
        ranked = sorted(zip(candidates, sims, strict=False), key=lambda pair: pair[1], reverse=True)
        brand_skel = skeleton(brand.get('name', ''))
        kept = []
        for cand, sim in ranked:
            mentions = len(brand_skel) >= 4 and brand_skel in skeleton(cand.get('description', ''))
            if sim >= self.threshold or mentions:
                kept.append((cand, float(sim)))
        return kept[:top_k]
