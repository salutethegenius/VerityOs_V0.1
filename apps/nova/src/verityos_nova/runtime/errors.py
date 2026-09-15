from __future__ import annotations


class NovaError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class UnmappedActorError(NovaError):
    def __init__(self) -> None:
        super().__init__(
            "UNMAPPED_SLACK_USER",
            "Your Slack account is not linked to a VerityOS user.",
            403,
        )


class BrandUnavailableError(NovaError):
    def __init__(self) -> None:
        super().__init__("BRAND_UNAVAILABLE", "brand unavailable", 404)


class ConnectorUnavailableError(NovaError):
    def __init__(self, connector: str = "meta") -> None:
        super().__init__(
            "CONNECTOR_NOT_AVAILABLE",
            f"{connector} publishing is not enabled in the VerityOS Nova runtime",
            409,
        )
