"""Starlette / FastAPI routes for the Enlitt account handlers."""

from __future__ import annotations

from urllib.parse import urlsplit

from starlette.routing import BaseRoute, Route

from . import asgi, auth
from . import client_sign_in as client_sign_in_module
from .auth import CallbackConfig
from .client_sign_in import ClientSignInConfig
from .errors import EnlittConfigurationError


def enlitt_routes(
    *,
    config: CallbackConfig,
    login_path: str = "/enlitt/login",
    callback_path: str = "/enlitt/callback",
    logout_path: str = "/enlitt/logout",
    client_sign_in: ClientSignInConfig | None = None,
) -> list[BaseRoute]:
    """Routes for the login, callback, and logout handlers (and client sign-in, when given).

    ``callback_path`` must be the path of ``config.redirect_uri``; a mismatch raises
    ``EnlittConfigurationError`` at construction. ``client_sign_in.callback`` should be
    ``config`` itself, because the handoff rides on the same login routes.
    """
    if urlsplit(config.redirect_uri).path != callback_path:
        raise EnlittConfigurationError("callback_path must equal the path of config.redirect_uri.")
    routes: list[BaseRoute] = [
        Route(login_path, asgi.asgi_app(auth.login_start_handler(config)), methods=["GET"]),
        Route(callback_path, asgi.asgi_app(auth.callback_handler(config)), methods=["GET"]),
        Route(
            logout_path,
            asgi.asgi_app(auth.logout_handler(config)),
            methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        ),
    ]
    if client_sign_in is not None:
        handler = client_sign_in_module.client_sign_in_handler(client_sign_in)
        routes.append(
            Route(
                f"{client_sign_in.base_path}/{{rest:path}}",
                asgi.asgi_app(handler),
                methods=["GET", "POST"],
            )
        )
    return routes
