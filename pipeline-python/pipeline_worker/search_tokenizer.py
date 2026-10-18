"""
Module: search_tokenizer
Search query tokenization using Jieba with custom dictionary and stopwords support.
模块：search_tokenizer
使用 Jieba 对搜索查询进行分词，支持自定义词典和停用词。
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Iterable

from .keyword_candidates import extract_search_tokens, load_builtin_stopwords, normalize_stopwords
from .keyword_tokenizer import create_keyword_tokenizer, normalize_dictionary_terms


# Maximum search query character limit / 搜索查询最大字符限制
MAX_SEARCH_QUERY_CHARACTERS = 4_096
# Maximum tokens per search query / 每次搜索查询的最大 token 数
MAX_SEARCH_QUERY_TOKENS = 64


def tokenize_search_query(
    query: str,
    dictionary_terms: Iterable[str] = (),
    custom_stopwords: Iterable[str] = (),
) -> dict[str, Any]:
    """
    Tokenize a search query using Jieba with dictionary and stopwords.
    使用 Jieba 对搜索查询进行分词，支持词典和停用词。

    @param query - Search query string / 搜索查询字符串
    @param dictionary_terms - Custom dictionary terms / 自定义词典词条
    @param custom_stopwords - Custom stopwords / 自定义停用词
    @returns Tokenization result with tokens, tokenizer info / 分词结果，包含 tokens、分词器信息
    """
    if not isinstance(query, str):
        raise ValueError('检索词必须是字符串。')
    normalized_query = query.strip()
    if len(normalized_query) > MAX_SEARCH_QUERY_CHARACTERS:
        raise ValueError('检索词超过 4096 个字符上限。')
    dictionary = normalize_dictionary_terms(dictionary_terms)
    stopwords = normalize_stopwords((*load_builtin_stopwords(), *custom_stopwords))
    tokenizer = _cached_jieba_tokenizer(dictionary)
    tokens = extract_search_tokens(
        normalized_query,
        tokenizer,
        stopwords=stopwords,
        max_tokens=MAX_SEARCH_QUERY_TOKENS,
    ) if normalized_query else ()
    return {
        'tokens': list(tokens),
        'tokenizer': str(getattr(tokenizer, 'name', 'jieba-accurate-hmm-off')),
        'tokenizerVersion': str(getattr(tokenizer, 'version', 'unresolved')),
        'dictionaryHash': str(getattr(tokenizer, 'dictionary_hash', 'none')),
    }


@lru_cache(maxsize=8)
def _cached_jieba_tokenizer(dictionary_terms: tuple[str, ...]):
    """
    Cache Jieba tokenizer instances per dictionary to avoid cross-library contamination.
    按词典缓存 Jieba 分词器实例，避免跨资料库污染。
    """
    # Each cache entry owns an isolated jieba.Tokenizer, so per-library
    # dictionaries never leak into another materials library.
    # 每个缓存条目拥有独立的 jieba.Tokenizer，确保每个资料库的词典不会泄露到其他资料库。
    return create_keyword_tokenizer('jieba', dictionary_terms)
