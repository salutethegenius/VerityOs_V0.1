from verityos_knowledge import (
    PARSER_VERSION,
    extract_text,
    sha256_bytes,
    sha256_text,
    strip_html,
)


def test_version_and_parser() -> None:
    assert PARSER_VERSION == "verity-knowledge-0.1"


def test_file_hashing_is_deterministic() -> None:
    assert sha256_bytes(b"hello") == sha256_text("hello")
    assert sha256_text("hello") != sha256_text("Hello")
    assert len(sha256_text("hello")) == 64


def test_html_and_text_extraction() -> None:
    assert strip_html("<p>Hello <b>world</b></p>") == "Hello world"
    assert extract_text("text/plain", b"plain") == "plain"
    assert extract_text("text/markdown", b"# Title") == "# Title"
    assert extract_text("text/html", b"<h1>Hi</h1>") == "Hi"
