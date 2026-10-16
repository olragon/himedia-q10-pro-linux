#define _GNU_SOURCE
/*
 * Minimal static PID 1 for Q10 Pro bring-up.
 *
 * ⛔ Why C and not the shell script: the shell script produced no observable effect at all,
 * and that outcome has two very different causes which look identical from outside —
 * (a) the kernel never managed to exec init, or (b) it ran and every busybox call failed.
 * A static ELF with no interpreter, no shebang, no PATH and no symlink resolution removes
 * every variable in (b). If this raises the alias, exec works and the shell was the problem.
 *
 * It sets a second address on eth0 by ioctl, which is a pure-ICMP signal needing no daemon,
 * then hands over to the shell script so the richer diagnostics still get a chance.
 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <errno.h>
#include <stdlib.h>
#include <dirent.h>
#include <sys/mount.h>

/*
 * ⭐ The userspace end of the watchdog telemetry channel.
 *
 * Checkpoint Q (in kernel_init) proves the kernel is ABOUT to exec /init. It cannot prove the
 * exec worked. If Q fires and nothing appears on the network, "exec failed" and "PID 1 ran but
 * the NIC never came up" look identical from outside and need completely different work — so
 * PID 1 arms the watchdog itself, before it touches the network at all.
 *
 * ⛔ Deliberately the FIRST thing main() does. Everything after it (sockets, ioctls, execl)
 * can fail; this cannot depend on any of them, or it stops being evidence that PID 1 ran.
 *
 * ⚠️ Needs CONFIG_DEVMEM=y and no CONFIG_STRICT_DEVMEM — both verified in the built .config.
 * Every failure path returns silently: a diagnostic that kills PID 1 is worse than no
 * diagnostic, and there is no console to print to anyway.
 *
 * ⛔ It CREATES /dev/mem itself rather than relying on the initramfs having it. The first
 * version did not, the build mknods only console/null/zero/tty, so open() failed and the
 * checkpoint never fired — making a boot that reached PID 1 indistinguishable from one that
 * never got there. A probe that cannot fire is not a probe. The rootfs is a writable rootfs
 * and we are root and this runs before anything mounts over /dev, so mknod is reliable here;
 * EEXIST is success.
 */
/*
 * ⛔ The NIC verdict is OFF this round (2026-10-10). It answered: DOWN (2:05). The short
 * readings are needed for init.sh's USB-log stages, and two reporters sharing one watchdog would
 * make a reading ambiguous. Set to 1 to bring it back.
 */
#define HIMEDIA_NIC_VERDICT 1	/* back ON (2026-10-10, PHY at address 1): the network is the
					 * question again; init.sh's USB stages are silenced (CP_SHELL=0) */
#define HIMEDIA_CP_SECONDS 80		/* must equal USERSPACE_PID1_SECONDS in checkpoints.ts */
#define HIMEDIA_WDT_BASE   0xf8a2c000UL
#define HIMEDIA_WDT_UNLOCK 0x1acce551u
#define HIMEDIA_APB_HZ     24000000u

/*
 * ⛔ Only touch the SP805 on the real board. Under QEMU `virt` 0xf8a2c000 is not mapped, the
 * store raises an external abort, and SIGBUS kills PID 1 — a panic that reads as "the image
 * is broken" when the image is fine (qemu --stick, 2026-10-11). The device tree decides.
 */
static int on_board(void)
{
	static int known = -1;
	char b[64];
	int fd, n, mounted;

	if (known >= 0)
		return known;
	mkdir("/sys", 0755);
	/* unmounted again below: main() and init.sh each mount /sys themselves and expect to */
	mounted = mount("sysfs", "/sys", "sysfs", 0, NULL) == 0;
	fd = open("/sys/firmware/devicetree/base/compatible", O_RDONLY);
	n = fd < 0 ? -1 : (int)read(fd, b, sizeof b - 1);
	if (fd >= 0)
		close(fd);
	if (mounted)
		umount("/sys");
	known = n > 0 && memmem(b, (size_t)n, "himedia,q10-pro", 15) != NULL;
	return known;
}

static void himedia_checkpoint(unsigned int secs)
{
	volatile unsigned int *w;
	void *m;
	int fd;

	if (!on_board())
		return;
	if (mknod("/dev/mem", S_IFCHR | 0600, makedev(1, 1)) < 0 && errno != EEXIST)
		return;
	fd = open("/dev/mem", O_RDWR | O_SYNC);
	if (fd < 0)
		return;
	m = mmap(NULL, 0x1000, PROT_READ | PROT_WRITE, MAP_SHARED, fd,
		 (off_t)HIMEDIA_WDT_BASE);
	if (m == MAP_FAILED) {
		close(fd);
		return;
	}
	w = (volatile unsigned int *)m;
	w[0xc00 / 4] = HIMEDIA_WDT_UNLOCK;
	w[0]         = secs * HIMEDIA_APB_HZ;
	w[2]         = 3u;			/* INTEN | RESEN */
	w[0xc00 / 4] = 3u;			/* re-lock: 3 is not the magic */
	munmap(m, 0x1000);
	close(fd);
}

static int set_alias(const char *dev, const char *addr, const char *mask)
{
	struct ifreq r;
	struct sockaddr_in *s = (struct sockaddr_in *)&r.ifr_addr;
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if (fd < 0)
		return -1;

	memset(&r, 0, sizeof r);
	strncpy(r.ifr_name, dev, IFNAMSIZ - 1);
	s->sin_family = AF_INET;

	s->sin_addr.s_addr = inet_addr(addr);
	if (ioctl(fd, SIOCSIFADDR, &r) < 0)
		return -1;

	s->sin_addr.s_addr = inet_addr(mask);
	if (ioctl(fd, SIOCSIFNETMASK, &r) < 0)
		return -1;

	if (ioctl(fd, SIOCGIFFLAGS, &r) < 0)
		return -1;
	r.ifr_flags |= IFF_UP | IFF_RUNNING;
	if (ioctl(fd, SIOCSIFFLAGS, &r) < 0)
		return -1;

	close(fd);
	return 0;
}

/*
 * ⭐ NIC verdict — PID 1 reads the kernel's own state and reports it through the watchdog.
 *
 * Checkpoint R (2026-10-10, 3:47) proved PID 1 runs, so the kernel boots fully and only the
 * network is dead (the box's MAC never reached ARP). Guessing at the cause cost rounds; sysfs
 * already knows the answer. One boot, one of eight periods, no console needed.
 *
 * Each period must equal its NIC_VERDICT entry in checkpoints.ts (a test asserts it), and the
 * FAST periods: every predicted reading is >= 18 s from every other (fastReadings()).
 */
/*
 * ⛔ v2 — identify devices by their `of_node` link, never by sysfs NAME. v1 matched names ending
 * in "9841000.ethernet" and reported NO_DEVICE (4:30, 2026-10-10). But of_device_make_bus_id
 * names a device "f9841000.ethernet" only when its reg translates; otherwise the name falls back
 * to "...ethernet@9841000", which v1 could not see. "No device" and "a device my check could not
 * recognise" read identically — so v1's verdict cannot be trusted, and this tree replaces it.
 * Ordered so each branch rules out the cheaper explanation first.
 */
#define NIC_NO_DT_NODE        5	/* ethernet@9841000 absent from the LIVE device tree */
#define NIC_NO_PLATFORM_DEVS  14	/* < 5 platform devices: DT population failed wholesale */
#define NIC_NO_GMAC_BUT_EHCI  24	/* ehci device exists, gmac does not: gmac-specific */
#define NIC_NO_GMAC_NO_EHCI   34	/* other devices exist, neither gmac nor ehci */
#define NIC_UNBOUND           45	/* gmac device exists, no driver bound / no netdev */
#define NIC_DOWN              55	/* netdev exists but is not UP: ndo_open failed */
#define NIC_NO_CARRIER        60	/* UP, but no carrier after 15 s */
#define NIC_CARRIER           300	/* carrier up: the link is physically up */

#define DT_GMAC "/sys/firmware/devicetree/base/soc@f0000000/ethernet@9841000"
#define PLATFORM "/sys/bus/platform/devices"

static int read_small(const char *path, char *buf, size_t n)
{
	ssize_t r;
	int fd = open(path, O_RDONLY);

	if (fd < 0)
		return -1;
	r = read(fd, buf, n - 1);
	close(fd);
	if (r < 0)
		return -1;
	buf[r] = 0;
	return (int)r;
}

/*
 * Find the platform device whose of_node link ends in `node` (e.g. "/ethernet@9841000").
 * Returns the number of platform devices seen, and fills `out` if the node matched.
 */
static int find_by_node(const char *node, char *out, size_t n, int *found)
{
	char link[400], tgt[400];
	struct dirent *e;
	size_t sl = strlen(node);
	int count = 0;
	DIR *d = opendir(PLATFORM);

	*found = 0;
	if (!d)
		return 0;
	while ((e = readdir(d)) != NULL) {
		ssize_t r;
		size_t l;

		if (e->d_name[0] == '.')
			continue;
		count++;
		if (*found)
			continue;
		snprintf(link, sizeof link, PLATFORM "/%s/of_node", e->d_name);
		r = readlink(link, tgt, sizeof tgt - 1);
		if (r <= 0)
			continue;
		tgt[r] = 0;
		l = (size_t)r;
		if (l >= sl && strcmp(tgt + l - sl, node) == 0) {
			snprintf(out, n, PLATFORM "/%s", e->d_name);
			*found = 1;
		}
	}
	closedir(d);
	return count;
}

/*
 * The netdev that belongs to THIS device: `<dev>/net/<name>`.
 *
 * ⛔ v2 took "the first non-lo entry in /sys/class/net" and assumed it was eth0. But this kernel
 * has CONFIG_IPV6_SIT=y, so `sit0` always exists and is always DOWN, and kernfs returns entries
 * in an order hashed from a kernel pointer. Every DOWN verdict (2:05, 2:07, 2:07 — 2026-10-10)
 * may have been sit0. Looking under the gmac device found by of_node cannot pick a tunnel.
 */
static int netdev_of(const char *dev, char *out, size_t n)
{
	char dir[420];
	struct dirent *e;
	DIR *d;
	int found = 0;

	snprintf(dir, sizeof dir, "%s/net", dev);
	d = opendir(dir);
	if (!d)
		return 0;
	while ((e = readdir(d)) != NULL) {
		if (e->d_name[0] == '.')
			continue;
		snprintf(out, n, "%s/%s", dir, e->d_name);
		found = 1;
		break;
	}
	closedir(d);
	return found;
}

static unsigned int nic_verdict(void)
{
	char dev[400], usb[400], net[460], path[480], buf[64];
	struct stat st;
	int i, count = 0, gmac = 0, ehci = 0;

	if (stat(DT_GMAC, &st) < 0)
		return NIC_NO_DT_NODE;

	/* Population happens at arch_initcall, long before PID 1; a short grace period anyway. */
	for (i = 0; i < 30; i++) {
		count = find_by_node("/ethernet@9841000", dev, sizeof dev, &gmac);
		if (gmac)
			break;
		usleep(100000);
	}
	if (!gmac) {
		if (count < 5)
			return NIC_NO_PLATFORM_DEVS;
		find_by_node("/usb@9890000", usb, sizeof usb, &ehci);
		return ehci ? NIC_NO_GMAC_BUT_EHCI : NIC_NO_GMAC_NO_EHCI;
	}

	snprintf(path, sizeof path, "%s/driver", dev);
	if (stat(path, &st) < 0 || !netdev_of(dev, net, sizeof net))
		return NIC_UNBOUND;

	snprintf(path, sizeof path, "%s/flags", net);
	if (read_small(path, buf, sizeof buf) < 0 || !(strtoul(buf, NULL, 16) & 0x1))
		return NIC_DOWN;

	/* Autonegotiation takes a few seconds; 15 s is generous for gigabit. */
	snprintf(path, sizeof path, "%s/carrier", net);
	for (i = 0; i < 150; i++) {
		if (read_small(path, buf, sizeof buf) > 0 && buf[0] == '1')
			return NIC_CARRIER;
		usleep(100000);
	}
	return NIC_NO_CARRIER;
}

int main(void)
{
	/* ⛔ FIRST, before anything that can fail: proof PID 1 was reached at all. */
	himedia_checkpoint(HIMEDIA_CP_SECONDS);

	/*
	 * Then the NIC verdict, which REPLACES R's period. If anything below crashes PID 1, R's
	 * period is what the box reports — so a crash here can never masquerade as a verdict.
	 * sysfs is unmounted again afterwards so init.sh's own mount sequence is unchanged.
	 */
#if HIMEDIA_NIC_VERDICT
	if (mount("sysfs", "/sys", "sysfs", 0, NULL) == 0) {
		himedia_checkpoint(nic_verdict());
		umount("/sys");
	}
#endif

	/* The signal: if 192.168.1.57 answers, a static binary ran as PID 1. */
	set_alias("eth0:0", "192.168.1.57", "255.255.255.0");

	/* Hand over to the shell for the richer diagnostics; if that fails we still have .56. */
	execl("/bin/busybox", "busybox", "sh", "/init.sh", (char *)NULL);

	/*
	 * ⛔ Never return. PID 1 exiting panics the kernel, and a panic would take the network
	 * down with it — destroying the very signal this program exists to produce.
	 */
	for (;;)
		pause();
}
