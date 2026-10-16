/*
 * q10-mii — read/write the Q10 Pro's RTL8211E RGMII delay register from a running box.
 *
 * Exists so the phy-mode can be chosen on a LIVE system (telnet + this tool) instead of one
 * reboot per hypothesis. Same register access as init.c's rgmii_sweep(): SIOCGMIIPHY, then
 * ext page 0xa4 reg 0x1c. bit13 = force (else the strap pins decide), bit12/bit11 = the two
 * delays (mainline names bit12 TX, bit11 RX).
 *
 *   q10-mii get                  -> prints reg 0x1c
 *   q10-mii set <bits>           -> writes (reg & ~0x3800) | bits, restarts autoneg
 *
 * Build: arm-linux-gnueabihf-gcc -static -O2 -o q10-mii q10-mii.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <net/if.h>
#include <linux/mii.h>
#include <linux/sockios.h>

static int fd;
static struct ifreq r;

static int mii(int wr, int reg, int val)
{
	struct mii_ioctl_data *d = (struct mii_ioctl_data *)&r.ifr_ifru;

	d->reg_num = reg;
	d->val_in = val;
	if (ioctl(fd, wr ? SIOCSMIIREG : SIOCGMIIREG, &r) < 0)
		return -1;
	return wr ? 0 : d->val_out;
}

int main(int argc, char **argv)
{
	int v;

	if (argc < 2)
		return fprintf(stderr, "usage: q10-mii get | set <bits>\n"), 2;
	fd = socket(AF_INET, SOCK_DGRAM, 0);
	strncpy(r.ifr_name, "eth0", IFNAMSIZ - 1);
	if (fd < 0 || ioctl(fd, SIOCGMIIPHY, &r) < 0)
		return perror("SIOCGMIIPHY"), 1;
	mii(1, 0x1f, 0x7);
	mii(1, 0x1e, 0xa4);
	v = mii(0, 0x1c, 0);
	if (!strcmp(argv[1], "set") && argc > 2)
		mii(1, 0x1c, (v & ~0x3800) | (int)strtol(argv[2], NULL, 0));
	v = mii(0, 0x1c, 0);
	mii(1, 0x1f, 0x0);
	if (!strcmp(argv[1], "set"))
		mii(1, 0, mii(0, 0, 0) | 0x0200);	/* BMCR: restart autoneg */
	printf("0x%04x\n", v);
	return 0;
}
