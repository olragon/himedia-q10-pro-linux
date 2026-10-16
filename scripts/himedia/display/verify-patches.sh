#!/bin/bash
# Prove the SHIPPED patches, not the working tree: pristine 6.18.55 + the whole stack below 0015
# (lib.sh) + 0015..0017 must apply with no reject, and every file the three touch must then equal the
# display tree that was compiled.  Offsets and fuzz are printed.  Exit non-zero on a reject or a difference.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
V=$ROOT/verify
base_tree "$V" > /dev/null
cd "$V/linux-6.18.55"
fail=0
for p in "$K"/arm32/0015-*.patch "$K"/arm32/0016-*.patch "$K"/arm32/0017-*.patch; do apply "$p" || fail=1; done
for f in $(cat "$K"/arm32/001[567]-*.patch | grep '^+++ b/' | sed 's/^+++ b\///' | sort -u); do
  cmp -s "$f" "$ROOT/linux-6.18.55/$f" || { echo "DIFFERS from the display tree: $f"; fail=1; }
done
[ $fail -eq 0 ] && echo "VERIFY OK: 0015..0017 apply on the full stack and reproduce the compiled tree byte for byte"
rm -rf "$V"
exit $fail
