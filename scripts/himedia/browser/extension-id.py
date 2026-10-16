#!/usr/bin/env python3
"""Print the Chromium extension ID derived from the "key" in a manifest.json (sha256 of the DER public key, first 16 bytes, hex -> a-p)."""
import base64, hashlib, json, sys

def ext_id(manifest_path):
    der = base64.b64decode(json.load(open(manifest_path))["key"])
    return "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(der).hexdigest()[:32])

if __name__ == "__main__":
    print(ext_id(sys.argv[1]))
