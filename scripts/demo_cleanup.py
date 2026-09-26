"""Delete the pre-deletion EBS snapshots the teardown created (tagged CostJanitor=pre-delete).

    python scripts/demo_cleanup.py            # list them
    python scripts/demo_cleanup.py --delete   # list, confirm, delete

Snapshots of mostly empty demo volumes cost cents, but they are billed until deleted.
"""
import argparse

import boto3


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--delete", action="store_true")
    args = parser.parse_args()

    ec2 = boto3.client("ec2", region_name=args.region)
    snaps = []
    for page in ec2.get_paginator("describe_snapshots").paginate(
        OwnerIds=["self"], Filters=[{"Name": "tag:CostJanitor", "Values": ["pre-delete"]}]
    ):
        snaps.extend(page["Snapshots"])

    if not snaps:
        print("No Cost Janitor snapshots found.")
        return
    for s in snaps:
        source = next((t["Value"] for t in s.get("Tags", []) if t["Key"] == "SourceVolume"), "?")
        print(f"  {s['SnapshotId']}  {s['VolumeSize']:>5} GiB  from {source}  {s['StartTime']:%Y-%m-%d %H:%M}")

    if not args.delete:
        print(f"{len(snaps)} snapshot(s). Re-run with --delete to remove them.")
        return
    if input(f"Delete these {len(snaps)} snapshot(s)? Type 'delete' to confirm: ").strip() != "delete":
        print("Nothing deleted.")
        return
    for s in snaps:
        ec2.delete_snapshot(SnapshotId=s["SnapshotId"])
        print(f"  deleted {s['SnapshotId']}")


if __name__ == "__main__":
    main()
