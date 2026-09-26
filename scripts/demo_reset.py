"""Clear findings, approvals, jobs and activity so the demo starts from an empty dashboard.

    python scripts/demo_reset.py --stack cost-janitor-prod --yes

Needs AWS credentials for the account. Config (thresholds, guardrails) is kept.
"""
import argparse
import sys

import boto3

TABLE_OUTPUTS = {
    "FindingsTableName": ["finding_id"],
    "ApprovalsTableName": ["approval_id"],
    "JobsTableName": ["job_id"],
    "ActivityTableName": ["day", "ts"],
}


def stack_outputs(stack: str, region: str) -> dict:
    cf = boto3.client("cloudformation", region_name=region)
    outputs = cf.describe_stacks(StackName=stack)["Stacks"][0].get("Outputs", [])
    return {o["OutputKey"]: o["OutputValue"] for o in outputs}


def clear(table, keys) -> int:
    count, kwargs = 0, {"ProjectionExpression": ", ".join(f"#k{i}" for i in range(len(keys))),
                        "ExpressionAttributeNames": {f"#k{i}": k for i, k in enumerate(keys)}}
    with table.batch_writer() as batch:
        while True:
            page = table.scan(**kwargs)
            for item in page.get("Items", []):
                batch.delete_item(Key={k: item[k] for k in keys})
                count += 1
            if "LastEvaluatedKey" not in page:
                return count
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stack", default="cost-janitor-prod")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--yes", action="store_true", help="Required: confirms you want to delete the rows")
    args = parser.parse_args()

    outputs = stack_outputs(args.stack, args.region)
    tables = {outputs[k]: keys for k, keys in TABLE_OUTPUTS.items() if k in outputs}
    print("Will clear:", ", ".join(tables))
    if not args.yes:
        sys.exit("Nothing deleted. Re-run with --yes to clear these tables.")

    ddb = boto3.resource("dynamodb", region_name=args.region)
    for name, keys in tables.items():
        print(f"  {name}: deleted {clear(ddb.Table(name), keys)} rows")


if __name__ == "__main__":
    main()
