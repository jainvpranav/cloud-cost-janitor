from mangum import Mangum

from server import create_app


def handler(event, context):
    # The SDK's session manager can only be started once per app, and Mangum runs the
    # lifespan on every invocation, so a warm container needs a fresh app each time.
    # Tools are registered once at import; building the app is cheap.
    return Mangum(create_app(local=False), lifespan="auto", api_gateway_base_path="/")(event, context)
