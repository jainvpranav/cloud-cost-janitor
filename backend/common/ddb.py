import json
from decimal import Decimal
from typing import Any


def to_ddb(obj: Any) -> Any:
    """boto3 rejects Python floats; DynamoDB numbers must be Decimal."""
    return json.loads(json.dumps(obj, default=str), parse_float=Decimal)


def from_ddb(obj: Any) -> Any:
    return json.loads(json.dumps(obj, cls=DecimalEncoder))


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o == o.to_integral_value() else float(o)
        if isinstance(o, set):
            return list(o)
        return str(o)


def dumps(obj: Any) -> str:
    return json.dumps(obj, cls=DecimalEncoder)
