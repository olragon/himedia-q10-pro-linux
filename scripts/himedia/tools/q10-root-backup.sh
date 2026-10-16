#!/bin/bash
# q10-root-backup.sh <name> [box-path=/] — MAC side: stream a filesystem of the box into
# ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/backups/<name>.tar.zst (GNU tar on the box: one filesystem, numeric ids, ACLs, xattrs,
# hard links; zstd on the Mac, the box CPU is slow). Read-only on the box. Verifies the archive lists
# cleanly and prints its size and file count (⚠️ the Mac's bsdtar undercounts GNU archives — count on the
# box with GNU tar when the number matters). Restore into a mounted target on the box:
#   zstd -dc <file> | ssh ${Q10_HOST:-root@q10.local} 'tar -xpf - --numeric-owner --acls --xattrs -C <target>'
# docs/261014-himedia-switch-to-wd-disk.md
set -uo pipefail
NAME=${1:?usage: q10-root-backup.sh <name> [box-path]}; SRC=${2:-/}; H=${Q10_HOST:-root@q10.local}
OUT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/backups/$NAME.tar.zst
[ -e "$OUT" ] && { echo "FAIL: $OUT exists — refusing to overwrite"; exit 1; }
mkdir -p ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/backups
echo "$(date +%T) box:$SRC → $OUT ($(ssh -o BatchMode=yes $H "du -sxh $SRC | cut -f1") on the box)"
ssh -o BatchMode=yes $H "tar -cpf - --one-file-system --numeric-owner --acls --xattrs -C $SRC . 2>/tmp/q10-root-backup.err; echo \$? > /tmp/q10-root-backup.rc" \
  | zstd -q -T0 -3 -o "$OUT" || { echo "FAIL: stream"; exit 1; }
rc=$(ssh -o BatchMode=yes $H 'cat /tmp/q10-root-backup.rc'); ssh -o BatchMode=yes $H 'tail -5 /tmp/q10-root-backup.err'
# GNU tar exits 1 when a file changed while it was read (a live root: logs, journal) — that is expected
[ "$rc" = 0 ] || [ "$rc" = 1 ] || { echo "FAIL: tar exit $rc on the box"; exit 1; }
n=$(zstd -dc "$OUT" | tar -tf - | wc -l | tr -d ' ') || { echo "FAIL: archive does not list"; exit 1; }
echo "$(date +%T) OK: $OUT $(du -h "$OUT" | cut -f1), $n entries, box tar exit $rc"
