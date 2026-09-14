from verityos_sdk import __version__


def test_sdk_skeleton_version() -> None:
    assert __version__ == "0.1.0.dev0"
