from verityos_nova import __version__


def test_nova_version() -> None:
    assert __version__ == "0.10.0"
