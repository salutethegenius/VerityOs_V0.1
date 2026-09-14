from verityos_nova import __version__


def test_nova_skeleton_version() -> None:
    assert __version__ == "0.1.0.dev0"
