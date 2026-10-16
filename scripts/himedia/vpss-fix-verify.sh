#!/bin/bash
# Verify the VPSS fix: (1) 0008 still applies on pristine 6.18.55 + 0001-0007 with patch -p1
# and its histb-vpss.c equals the working tree; (2) W=1 module build of the hisilicon dir.
# Touches only ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdec-port (verify/ is re-extracted).
set -u
V=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdec-port
rm -rf $V/verify/linux-6.18.55   # a re-extract over an applied tree makes patch prompt for "reversed?"
sed "s/patch -p1 --no-backup-if-mismatch/patch -p1 --batch --no-backup-if-mismatch/" $V/tools/verify.sh > $V/verify/verify-batch.sh
bash $V/verify/verify-batch.sh 2>&1 | grep -E "^==|APPLY-OK|FAILED|rej|Hunk|fuzz|offset" ; echo "verify_exit=${PIPESTATUS[0]}"
cmp $V/verify/linux-6.18.55/drivers/media/platform/hisilicon/histb-vpss.c \
    $V/linux-6.18.55/drivers/media/platform/hisilicon/histb-vpss.c && echo VPSS-IDENTICAL
cmp $V/verify/linux-6.18.55/drivers/media/platform/hisilicon/histb-vdec-core.c \
    $V/linux-6.18.55/drivers/media/platform/hisilicon/histb-vdec-core.c && echo VDEC-IDENTICAL
bash $V/tools/kbuild.sh vpssfail-modules.log 'make W=1 KBUILD_MODPOST_WARN=1 M=drivers/media/platform/hisilicon modules 2>&1; echo make_exit=$?'
grep -vE "undefined!|^  (CC|LD|MODPOST|LDS)" $V/logs/vpssfail-modules.log
ls -la $V/linux-6.18.55/drivers/media/platform/hisilicon/*.ko
