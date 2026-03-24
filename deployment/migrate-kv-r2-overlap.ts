/**
 * Migration script: find files that exist in both R2 and KV, then purge from KV
 * if the R2 object was uploaded within the last 3 months (meaning R2 is the
 * current canonical version and the KV entry is stale).
 *
 * Usage: tsx migrate-kv-r2-overlap.ts [--dry-run]
 *
 * Requires the same env vars as index.ts:
 *   DEPLOYMENT_CF_BUCKET, DEPLOYMENT_CF_ACCOUNT_ID,
 *   DEPLOYMENT_CF_AWS_ACCESS_KEY_ID, DEPLOYMENT_CF_AWS_SECRET_ACCESS_KEY,
 *   DEPLOYMENT_CF_API_KEY, DEPLOYMENT_CF_NAMESPACE
 */

import {
    S3Client,
    ListObjectsV2Command,
    ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";

function requiresEnv(name: string) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
}

const bucket = requiresEnv("DEPLOYMENT_CF_BUCKET");
const accountId = requiresEnv("DEPLOYMENT_CF_ACCOUNT_ID");
const accessKeyId = requiresEnv("DEPLOYMENT_CF_AWS_ACCESS_KEY_ID");
const secretAccessKey = requiresEnv("DEPLOYMENT_CF_AWS_SECRET_ACCESS_KEY");
const apiKey = requiresEnv("DEPLOYMENT_CF_API_KEY");
const namespace = requiresEnv("DEPLOYMENT_CF_NAMESPACE");

const dryRun = process.argv.includes("--dry-run");

const s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
});

interface R2Object {
    key: string;
    lastModified: Date;
    size: number;
}

async function listR2Objects(): Promise<R2Object[]> {
    const objects: R2Object[] = [];
    let continuationToken: string | undefined;

    do {
        const response: ListObjectsV2CommandOutput = await s3Client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                ContinuationToken: continuationToken,
            }),
        );

        for (const obj of response.Contents ?? []) {
            if (obj.Key && obj.LastModified) {
                objects.push({
                    key: obj.Key,
                    lastModified: obj.LastModified,
                    size: obj.Size ?? 0,
                });
            }
        }

        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
}

async function listKvKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    let cursor: string | undefined;

    do {
        const params = new URLSearchParams({ limit: "1000" });
        if (cursor) params.set("cursor", cursor);

        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespace}/keys?${params}`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (!response.ok) {
            throw new Error(
                `Failed to list KV keys: ${response.status} ${response.statusText} (${await response.text()})`,
            );
        }

        const data = (await response.json()) as {
            result: { name: string }[];
            result_info: { cursor?: string };
            success: boolean;
        };

        for (const item of data.result) {
            keys.add(item.name);
        }

        cursor = data.result_info?.cursor;
        // Cloudflare returns an empty string cursor when done
        if (cursor === "") cursor = undefined;
    } while (cursor);

    return keys;
}

async function deleteFromKv(keys: string[]) {
    // Batch in groups of 1000 (CF limit)
    for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespace}/bulk/delete`;
        const response = await fetch(url, {
            method: "POST",
            body: JSON.stringify(batch),
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(
                `Failed to delete from KV: ${response.status} ${response.statusText} (${await response.text()})`,
            );
        }

        console.log(`  Deleted batch of ${batch.length} keys from KV.`);

        if (i + 1000 < keys.length) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

(async () => {
    console.log("Listing R2 objects...");
    const r2Objects = await listR2Objects();
    console.log(`Found ${r2Objects.length} objects in R2.`);

    console.log("\nListing KV keys...");
    const kvKeys = await listKvKeys();
    console.log(`Found ${kvKeys.size} keys in KV.`);

    // Build a map of R2 key → object for fast lookup
    const r2ByKey = new Map<string, R2Object>();
    for (const obj of r2Objects) {
        r2ByKey.set(obj.key, obj);
    }

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    // Find overlap
    const inBoth: R2Object[] = [];
    for (const key of kvKeys) {
        const r2Obj = r2ByKey.get(key);
        if (r2Obj) {
            inBoth.push(r2Obj);
        }
    }

    console.log(
        `\n=== Files present in BOTH R2 and KV (${inBoth.length} total) ===`,
    );
    if (inBoth.length === 0) {
        console.log("  None found. Nothing to do.");
        return;
    }

    const toDelete: R2Object[] = [];
    const tooOld: R2Object[] = [];

    for (const obj of inBoth) {
        if (obj.lastModified >= threeMonthsAgo) {
            toDelete.push(obj);
        } else {
            tooOld.push(obj);
        }
    }

    console.log("\n--- R2 objects < 3 months old (will purge from KV) ---");
    if (toDelete.length === 0) {
        console.log("  None.");
    } else {
        for (const obj of toDelete) {
            console.log(
                `  ${obj.key}  (R2 size: ${obj.size} bytes, last modified: ${obj.lastModified.toISOString()})`,
            );
        }
    }

    console.log(
        "\n--- R2 objects >= 3 months old (will NOT purge from KV) ---",
    );
    if (tooOld.length === 0) {
        console.log("  None.");
    } else {
        for (const obj of tooOld) {
            console.log(
                `  ${obj.key}  (R2 size: ${obj.size} bytes, last modified: ${obj.lastModified.toISOString()})`,
            );
        }
    }

    if (toDelete.length === 0) {
        console.log("\nNothing to delete.");
        return;
    }

    if (dryRun) {
        console.log(
            `\n[DRY RUN] Would delete ${toDelete.length} keys from KV (${toDelete.map((o) => o.key).join(", ")}).`,
        );
        return;
    }

    console.log(`\nDeleting ${toDelete.length} keys from KV...`);
    await deleteFromKv(toDelete.map((o) => o.key));
    console.log("Done.");
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
