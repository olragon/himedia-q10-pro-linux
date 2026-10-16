// SPDX-License-Identifier: GPL-2.0
/*
 * q10_aiao — minimal ALSA playback driver for the HiSilicon Hi3798CV200 audio block (AIAO),
 * written for the HiMedia Q10 Pro. 48 kHz, S16_LE, stereo, from one DMA ring in DDR to:
 *   - I2S TX2  -> the internal "Tianlai v600" DAC -> RCA jacks
 *   - SPDIF TX1 -> optical + coax
 *   - I2S TX3  -> the HDMI transmitter's audio input (hard-wired: with TX3 running the HDMI ACR
 *               measures CTS ~148 500 at 1080p60/48 kHz; heard on a TV, 2026-10-11)
 * All ports read the SAME ring (each keeps its own read pointer); the first enabled port's
 * pointer drives ALSA. HDMI side: docs/261011-himedia-hdmi-audio-recipe.md — audio is added on
 * top of the link the stock fastboot brought up; video registers are never touched.
 *
 * Every register write follows docs/261011-himedia-aiao-programming-recipe.md (vendor SDK
 * 4.4.35, file:line cited there). No device-tree node and no IRQ: the module creates its own
 * platform device and an hrtimer polls the hardware read pointer, so it loads on any kernel of
 * the matching release with insmod. Mainline has no driver for this block.
 *
 * Module params: outputs=7 (bit0 DAC/RCA, bit1 S/PDIF, bit2 HDMI), mclk_div (NCO step override).
 * `outputs` decides which ports exist; the "RCA / SPDIF / HDMI Playback Switch" controls turn each
 * one on or off LIVE through the port's own hardware mute (with fade), so settings need no reload.
 */
#include <linux/delay.h>
#include <linux/dma-mapping.h>
#include <linux/hrtimer.h>
#include <linux/io.h>
#include <linux/module.h>
#include <linux/platform_device.h>
#include <sound/asoundef.h>
#include <sound/control.h>
#include <sound/core.h>
#include <sound/initval.h>
#include <sound/pcm.h>

#define AIAO_BASE	0xf8cd0000
#define AIAO_SIZE	0x10000
#define CRG_BASE	0xf8a22000
#define PERI_BASE	0xf8a20000

/* AIAO common */
#define AIAO_INT_ENA		0x000
#define AIAO_SPDIF_TX_MUX	0x020
#define AIAO_SWITCH_TX_BCLK	0x02c
#define AIAO_STATUS		0x030
#define AIAO_OUT_STANDING	0x034
#define AIAO_HW_CAPABILITY	0x00c
#define I2S_TX_CRG_CFG0(n)	(0x140 + 8 * (n))
#define I2S_TX_CRG_CFG1(n)	(0x144 + 8 * (n))
#define SPDIF_CRG_CFG0(n)	(0x180 + 8 * (n))
#define SPDIF_CRG_CFG1(n)	(0x184 + 8 * (n))

/* ports (I2S TX and SPDIF-TX DMA share one layout) */
#define PORT_TX2	0x2200
#define PORT_SPDIF1	0x3100
#define PORT_TX3	0x2300
static const u32 port_of[3] = { PORT_TX2, PORT_SPDIF1, PORT_TX3 };	/* by outputs bit */
#define P_IF_ATTRI	0x00
#define P_DSP_CTRL	0x04
#define P_BUFF_SADDR	0x80
#define P_BUFF_SIZE	0x84
#define P_BUFF_WPTR	0x88
#define P_BUFF_RPTR	0x8c
#define P_ALEMPTY_TH	0x90
#define P_TRANS_SIZE	0x94
#define P_INT_ENA	0xa0
#define P_INT_RAW	0xa4
#define P_INT_CLR	0xac
#define DSP_TX_ENABLE		BIT(28)
#define DSP_TX_DISABLE_DONE	BIT(29)
#define DSP_TX_BYPASS		BIT(27)		/* no volume / fade / mute-ramp on the samples [recipe 0x04 TX_DSP_CTRL] */
#define DSP_TX_MUTE		BIT(0)

/* SPDIF encoder 1 */
#define SPDIFER1	0x5000
#define SPDIF_CTRL	0x00
#define SPDIF_CONFIG	0x04
#define SPDIF_CS1	0x20
#define SPDIF_CS2	0x24
#define SPDIF_CS3	0x28
#define SPDIF_CS4	0x2c
#define SPDIF_CS5	0x30

/* CRG / PERI */
#define CRG_EPLL0	0x030
#define CRG_EPLL1	0x034
#define CRG69_ADAC	0x114
#define CRG70_AIAO	0x118
#define PERI_ADAC0	0x110
#define PERI_ADAC1	0x114
#define PERI_ADAC2	0x160

/* HDMI TX (SiI-derived core): 8-bit registers, one per 32-bit word */
#define HDMI_BASE	0xf8ce0000
#define HDMI_SIZE	0x4000
#define H_TEST_TXCTRL	0x03dc
#define H_FSEL		0x1afc
#define H_IF_B0		0x1b00
#define H_IF_EN		0x1b7c
#define H_ACR_CTRL	0x2804
#define H_N1		0x280c
#define H_N2		0x2810
#define H_N3		0x2814
#define H_AUD_EN	0x284c
#define H_AUD_MODE	0x2850
#define H_I2S_IN_CTRL	0x2874
#define H_CHST0		0x2878
#define H_CHST1		0x287c
#define H_CHST2		0x2880
#define H_CHST3		0x2884
#define H_CHST4		0x2888
#define H_ASRC		0x288c
#define H_I2S_IN_SIZE	0x2890
#define H_CHST6		0x28a0
#define H_CHST7		0x28a4
#define H_AIP_RST	0x28b0
#define H_AUDP_TXCTRL	0x28bc
#define H_DOWN_SMPL	0x2984
#define H_TPI_AUD_FS	0x298c
#define PERI_HDMITX_CTRL0 0x8b0

#define MCLK_DIV_48K_256FS	0x001af286	/* 12.288 MHz from a 933.888 MHz EPLL */
#define RING_MAX	(64 * 1024)
#define GAP		32			/* rptr == wptr means EMPTY: never fill completely */

static int outputs = 7;
module_param(outputs, int, 0444);
MODULE_PARM_DESC(outputs, "bit0 = internal DAC (RCA), bit1 = S/PDIF (optical+coax), bit2 = HDMI");
static uint mclk_div = MCLK_DIV_48K_256FS;
module_param(mclk_div, uint, 0444);
MODULE_PARM_DESC(mclk_div, "NCO step: mclk = EPLL * mclk_div / 2^27 (12.288 MHz wanted)");

struct q10 {
	void __iomem *aiao, *crg, *peri, *hdmi;
	struct snd_card *card;
	struct snd_pcm_substream *ss;
	struct hrtimer timer;
	ktime_t tick;
	spinlock_t lock;
	unsigned int buf_bytes, period_bytes, last_period;
	bool running;
	u8 iec958[4];		/* "IEC958 Playback Default": AES0..AES3 channel status */
	u8 on;			/* Playback Switch state, by outputs bit: 1 = audible */
};

static void rmw(void __iomem *r, u32 mask, u32 val)
{
	writel((readl(r) & ~mask) | (val & mask), r);
}

/* ---------------------------------------------------------------- hardware bring-up */

static int aiao_power_on(struct q10 *q)		/* recipe A.1 */
{
	void __iomem *c70 = q->crg + CRG70_AIAO;
	int i;

	rmw(c70, BIT(4), BIT(4));			/* hold reset */
	rmw(c70, GENMASK(21, 20), 0);			/* MCLK from EPLL */
	rmw(c70, BIT(0), BIT(0));			/* clock on */
	udelay(1);
	rmw(c70, BIT(4), 0);				/* release */
	for (i = 0; i < 1000 && !(readl(q->aiao + AIAO_STATUS) & 1); i++)
		udelay(1);
	if (!(readl(q->aiao + AIAO_STATUS) & 1))
		return -ETIMEDOUT;
	rmw(c70, BIT(22), BIT(22));			/* bus clock 50 MHz */
	rmw(c70, BIT(17), 0);
	rmw(c70, GENMASK(16, 12), 0);
	rmw(c70, BIT(17), BIT(17));
	if (!readl(q->aiao + AIAO_HW_CAPABILITY))
		return -ENODEV;
	rmw(q->aiao + AIAO_OUT_STANDING, GENMASK(2, 0), 2);
	writel(0, q->aiao + AIAO_INT_ENA);		/* polled: no interrupts */
	return 0;
}

static void port_dsp_defaults(void __iomem *p)	/* recipe A.4: unmuted, 0 dB, no bypass */
{
	writel(0, p + P_INT_ENA);
	rmw(p + P_IF_ATTRI, GENMASK(18, 16), 0);	/* stereo track mode */
	rmw(p + P_DSP_CTRL, GENMASK(27, 0),
	    (4 << 16) | (3 << 20) | (0x79 << 8) | BIT(1));
}

static void tx2_setup(struct q10 *q)		/* recipe A.3 */
{
	void __iomem *p = q->aiao + PORT_TX2;

	writel(0xe4200014, p + P_IF_ATTRI);		/* I2S, 16-bit, 2 ch, src TX2, SD map 0123 */
	writel(mclk_div, q->aiao + I2S_TX_CRG_CFG0(2));
	writel(0x133, q->aiao + I2S_TX_CRG_CFG1(2));	/* bclk idx 3 (64fs), fs idx 3, cken */
	rmw(q->aiao + AIAO_SWITCH_TX_BCLK, GENMASK(11, 8), 10 << 8);
	port_dsp_defaults(p);
}

static void spdif_setup(struct q10 *q)		/* recipe B.2, B.3 */
{
	void __iomem *p = q->aiao + PORT_SPDIF1, *e = q->aiao + SPDIFER1;

	rmw(q->aiao + AIAO_SPDIF_TX_MUX, GENMASK(11, 8), 0x9 << 8);	/* pad 1 <- engine TX1 */
	writel(0x14, p + P_IF_ATTRI);			/* 16-bit, 2 ch */
	writel(mclk_div, q->aiao + SPDIF_CRG_CFG0(1));
	writel(0x142, q->aiao + SPDIF_CRG_CFG1(1));	/* bclk idx 2 (128fs), fs idx 4, cken; srst 0 */
	writel(0, e + SPDIF_CONFIG);			/* linear PCM */
	writel(0x0404, e + SPDIF_CS1);			/* PCM, copy allowed */
	writel(0x0000, e + SPDIF_CS2);			/* category general */
	writel(0x2010, e + SPDIF_CS3);			/* channel numbers L1 R2 */
	writel(0x0202, e + SPDIF_CS4);			/* 48 kHz */
	writel(0xd2d2, e + SPDIF_CS5);			/* 16-bit, orig fs 48 kHz */
	port_dsp_defaults(p);
}

static void tx3_setup(struct q10 *q)		/* HDMI recipe §2: TX2's twin on CRG3 */
{
	void __iomem *p = q->aiao + PORT_TX3;

	writel(0xe4300014, p + P_IF_ATTRI);		/* I2S, 16-bit, 2 ch, src TX3 */
	writel(mclk_div, q->aiao + I2S_TX_CRG_CFG0(3));
	writel(0x133, q->aiao + I2S_TX_CRG_CFG1(3));
	rmw(q->aiao + AIAO_SWITCH_TX_BCLK, GENMASK(15, 12), 11 << 12);
	port_dsp_defaults(p);
}

static u32 h_rd(struct q10 *q, u32 o) { return readl(q->hdmi + o) & 0xff; }
static void h_wr(struct q10 *q, u32 o, u32 v) { writel(v & 0xff, q->hdmi + o); }
static void h_set(struct q10 *q, u32 o, u32 b) { h_wr(q, o, h_rd(q, o) | b); }
static void h_clr(struct q10 *q, u32 o, u32 b) { h_wr(q, o, h_rd(q, o) & ~b); }

/* Audio InfoFrame in TPI buffer 2 (FSEL 2); the selector is restored so AVI/GCP are untouched. */
static void hdmi_audio_infoframe(struct q10 *q, bool on)
{
	static const u8 aif[] = { 0x84, 0x01, 0x0a, 0x70, 0x01 };	/* type, ver, len, csum, CC=2ch */
	u32 f0 = h_rd(q, H_FSEL);
	int i;

	h_wr(q, H_FSEL, 2);
	h_clr(q, H_IF_EN, 0xc0);
	if (on) {
		for (i = 0; i < 31; i++)
			h_wr(q, H_IF_B0 + 4 * i, i < ARRAY_SIZE(aif) ? aif[i] : 0);
		h_set(q, H_IF_EN, 0xc0);			/* enable + repeat */
	}
	h_wr(q, H_FSEL, f0);
}

/* HDMI recipe §3: 48 kHz / 16-bit / 2-ch LPCM from I2S, N = 6144, hardware-measured CTS. */
static int hdmi_audio_enable(struct q10 *q)
{
	if (!(h_rd(q, H_TEST_TXCTRL) & 0x02))
		return -EOPNOTSUPP;			/* DVI mode: no data islands */
	/* quiesce first (the recipe's "off") */
	h_clr(q, H_AUD_EN, 0x01);
	h_clr(q, H_ACR_CTRL, 0x02);
	h_set(q, H_AUDP_TXCTRL, 0x80);
	h_set(q, H_AIP_RST, 0x03);
	udelay(2000);
	h_clr(q, H_AIP_RST, 0x03);
	hdmi_audio_infoframe(q, false);

	rmw(q->peri + PERI_HDMITX_CTRL0, GENMASK(4, 0), 0x02);	/* audio input = I2S */
	h_wr(q, H_I2S_IN_CTRL, 0x60);
	h_wr(q, H_I2S_IN_SIZE, 0x0b);
	h_wr(q, H_CHST0, 0); h_wr(q, H_CHST1, 0); h_wr(q, H_CHST2, 0);
	h_wr(q, H_CHST3, 0x02);					/* 48 kHz */
	h_wr(q, H_CHST4, 0x02);					/* 16-bit */
	h_wr(q, H_CHST6, 0); h_wr(q, H_CHST7, 0);
	h_wr(q, H_TPI_AUD_FS, (h_rd(q, H_TPI_AUD_FS) & 0xf0) | 0x02);
	h_clr(q, H_AUDP_TXCTRL, 0x02);				/* layout 0 */
	h_wr(q, H_AUD_MODE, 0x10);				/* SD0 only */
	h_wr(q, H_ASRC, (h_rd(q, H_ASRC) & 0x0f) | 0x10);
	h_wr(q, H_DOWN_SMPL, (h_rd(q, H_DOWN_SMPL) & 0xfc) | 0x03);
	h_wr(q, H_N1, 0x00); h_wr(q, H_N2, 0x18); h_wr(q, H_N3, 0x00);	/* N = 6144 */
	hdmi_audio_infoframe(q, true);
	h_set(q, H_AUD_EN, 0x01);
	h_clr(q, H_AUD_EN, 0x02);
	h_set(q, H_ACR_CTRL, 0x02);
	h_clr(q, H_AUDP_TXCTRL, 0x80);				/* unmute audio packets */
	return 0;
}

static void dac_power_up(struct q10 *q)		/* recipe A.5: vendor pop-free sequence */
{
	void __iomem *a0 = q->peri + PERI_ADAC0, *a1 = q->peri + PERI_ADAC1,
		     *a2 = q->peri + PERI_ADAC2, *c69 = q->crg + CRG69_ADAC;

	rmw(c69, BIT(0), BIT(0));
	udelay(10);
	rmw(a2, BIT(13), BIT(13));
	rmw(a2, BIT(13), 0);
	rmw(a2, BIT(25), 0);
	rmw(a2, BIT(24), BIT(24));
	rmw(c69, BIT(4), BIT(4));
	rmw(c69, BIT(4), 0);
	msleep(1);
	rmw(a0, BIT(30) | BIT(31), 0);			/* digital power on */
	rmw(a0, BIT(28) | BIT(29), 0);			/* unmute */
	rmw(a0, GENMASK(14, 0), (0x7f << 8) | 0x7f);	/* quietest while ramping up */
	rmw(a0, BIT(23) | BIT(22), BIT(22));		/* paths */
	rmw(a2, GENMASK(20, 16), 0);
	rmw(a1, GENMASK(2, 1) | GENMASK(5, 4), (1 << 1) | (1 << 4));
	rmw(a2, BIT(5) | BIT(6), BIT(5) | BIT(6));
	rmw(a2, BIT(14) | BIT(15), BIT(14) | BIT(15));
	rmw(a1, BIT(0) | BIT(3), 0);
	rmw(a2, BIT(7) | BIT(3) | BIT(4), 0);
	rmw(a2, BIT(22) | BIT(23) | BIT(21), BIT(22) | BIT(23));
	rmw(a2, BIT(2), 0);
	rmw(a1, BIT(0) | BIT(3), BIT(0) | BIT(3));
	msleep(500);
	rmw(a2, BIT(5) | BIT(6), 0);
	rmw(a2, BIT(14) | BIT(15), 0);
	rmw(a1, GENMASK(23, 22), 3 << 22);		/* data_bits */
	rmw(a1, GENMASK(21, 19), 2 << 19);		/* 32/44.1/48 kHz */
	rmw(a0, GENMASK(14, 0), (0x06 << 8) | 0x06);	/* 0 dB */
}

static void port_ring(void __iomem *p, dma_addr_t a, unsigned int size, unsigned int period)
{
	writel(lower_32_bits(a), p + P_BUFF_SADDR);
	writel(size, p + P_BUFF_SIZE);
	writel(0, p + P_BUFF_WPTR);
	writel(0, p + P_BUFF_RPTR);
	writel(period, p + P_ALEMPTY_TH);
	writel(period, p + P_TRANS_SIZE);
}

static void port_stop(void __iomem *p)		/* recipe §9, atomic-safe */
{
	int i;

	rmw(p + P_DSP_CTRL, DSP_TX_ENABLE, 0);
	writel(1, p + P_TRANS_SIZE);			/* vendor HW_CHN_PTR_BUG workaround */
	writel(0, p + P_BUFF_RPTR);
	udelay(500);
	for (i = 0; i < 100 && !(readl(p + P_DSP_CTRL) & DSP_TX_DISABLE_DONE); i++)
		udelay(10);
	writel(readl(p + P_INT_RAW), p + P_INT_CLR);
}

/* ---------------------------------------------------------------- IEC958 / non-PCM passthrough */

/*
 * AC3 / DTS-core bitstreams (IEC 61937) ride the same 48 kHz / 16-bit / 2-channel ring as PCM, so
 * the only differences are: the channel status must say "not audio" (AES0 bit 1) - on HDMI in the
 * TX's CHST registers, on S/PDIF in the encoder's - the AIAO must not touch the samples (bypass: no
 * volume, fade or mute ramp) and the analog DAC, which reads the same ring, must be muted or it
 * plays the bitstream as noise.  Userspace asks through the standard ALSA control (alsa-lib's
 * `hdmi:` / `iec958:` plugins write it from their AES0..AES3 arguments).
 * E-AC3 192 kHz, TrueHD and DTS-HD need HBR packets and are NOT covered here.
 */
static bool q10_nonaudio(struct q10 *q)
{
	return q->iec958[0] & IEC958_AES0_NONAUDIO;
}

/*
 * Per-port mute from two causes: the user's Playback Switch, and the non-audio rule (the analog DAC
 * must not play a bitstream). Bypass skips the mute ramp, so a switched-off digital port leaves
 * bypass and mutes instead: a muted port sends silence whatever the stream is. Caller holds q->lock.
 */
static void q10_apply_mutes(struct q10 *q)
{
	bool na = q10_nonaudio(q);

	if (outputs & 4) {
		bool off = !(q->on & 4);

		rmw(q->aiao + PORT_TX3 + P_DSP_CTRL, DSP_TX_BYPASS | DSP_TX_MUTE,
		    off ? DSP_TX_MUTE : (na ? DSP_TX_BYPASS : 0));
	}
	if (outputs & 2) {
		bool off = !(q->on & 2);

		rmw(q->aiao + PORT_SPDIF1 + P_DSP_CTRL, DSP_TX_BYPASS | DSP_TX_MUTE,
		    off ? DSP_TX_MUTE : (na ? DSP_TX_BYPASS : 0));
	}
	if (outputs & 1)
		rmw(q->aiao + PORT_TX2 + P_DSP_CTRL, DSP_TX_MUTE,
		    (na || !(q->on & 1)) ? DSP_TX_MUTE : 0);
}

static void q10_apply_iec958(struct q10 *q)
{
	bool na = q10_nonaudio(q);

	if (outputs & 4) {
		/* the TX numbers the 48 kHz in AES3; a zero there is "not set": keep the recipe's 0x02 */
		h_wr(q, H_CHST0, q->iec958[0]);
		h_wr(q, H_CHST1, q->iec958[1]);
		h_wr(q, H_CHST2, q->iec958[2]);
		h_wr(q, H_CHST3, q->iec958[3] ? q->iec958[3] : 0x02);
	}
	if (outputs & 2) {
		void __iomem *sp = q->aiao + SPDIFER1;

		/* [inferred] CS1 carries AES0 of both channels, as the PCM default 0x0404 shows */
		writel(na ? 0x0606 : 0x0404, sp + SPDIF_CS1);
		writel(na ? 1 : 0, sp + SPDIF_CONFIG);		/* 0 = PCM, 1 = compressed */
	}
	q10_apply_mutes(q);
	if (na)
		dev_info(q->card->dev, "non-audio (IEC 61937) stream: DAC muted, HDMI/S-PDIF in bypass\n");
}

static int q10_iec958_info(struct snd_kcontrol *kctl, struct snd_ctl_elem_info *uinfo)
{
	uinfo->type = SNDRV_CTL_ELEM_TYPE_IEC958;
	uinfo->count = 1;
	return 0;
}

static int q10_iec958_get(struct snd_kcontrol *kctl, struct snd_ctl_elem_value *uc)
{
	struct q10 *q = snd_kcontrol_chip(kctl);

	memcpy(uc->value.iec958.status, q->iec958, sizeof(q->iec958));
	return 0;
}

static int q10_iec958_put(struct snd_kcontrol *kctl, struct snd_ctl_elem_value *uc)
{
	struct q10 *q = snd_kcontrol_chip(kctl);
	unsigned long flags;
	bool changed;

	spin_lock_irqsave(&q->lock, flags);
	changed = memcmp(q->iec958, uc->value.iec958.status, sizeof(q->iec958));
	if (changed) {
		memcpy(q->iec958, uc->value.iec958.status, sizeof(q->iec958));
		q10_apply_iec958(q);
	}
	spin_unlock_irqrestore(&q->lock, flags);
	return changed;
}

static int q10_iec958_mask_get(struct snd_kcontrol *kctl, struct snd_ctl_elem_value *uc)
{
	memset(uc->value.iec958.status, 0xff, 4);
	return 0;
}

static int q10_switch_info(struct snd_kcontrol *kctl, struct snd_ctl_elem_info *uinfo)
{
	uinfo->type = SNDRV_CTL_ELEM_TYPE_BOOLEAN;
	uinfo->count = 1;
	uinfo->value.integer.min = 0;
	uinfo->value.integer.max = 1;
	return 0;
}

static int q10_switch_get(struct snd_kcontrol *kctl, struct snd_ctl_elem_value *uc)
{
	struct q10 *q = snd_kcontrol_chip(kctl);

	uc->value.integer.value[0] = !!(q->on & kctl->private_value);
	return 0;
}

static int q10_switch_put(struct snd_kcontrol *kctl, struct snd_ctl_elem_value *uc)
{
	struct q10 *q = snd_kcontrol_chip(kctl);
	u8 bit = kctl->private_value, want = uc->value.integer.value[0] ? bit : 0;
	unsigned long flags;
	bool changed;

	spin_lock_irqsave(&q->lock, flags);
	changed = (q->on & bit) != want;
	if (changed) {
		q->on = (q->on & ~bit) | want;
		q10_apply_mutes(q);
	}
	spin_unlock_irqrestore(&q->lock, flags);
	return changed;
}

#define Q10_SWITCH(xname, bit) { .iface = SNDRV_CTL_ELEM_IFACE_MIXER, .name = xname, \
	.info = q10_switch_info, .get = q10_switch_get, .put = q10_switch_put, .private_value = bit }
static const struct snd_kcontrol_new q10_switch_ctls[] = {	/* indexed by outputs bit */
	Q10_SWITCH("RCA Playback Switch", 1),
	Q10_SWITCH("SPDIF Playback Switch", 2),
	Q10_SWITCH("HDMI Playback Switch", 4),
};

static const struct snd_kcontrol_new q10_iec958_ctls[] = {
	{
		.iface = SNDRV_CTL_ELEM_IFACE_PCM,
		.name = SNDRV_CTL_NAME_IEC958("", PLAYBACK, DEFAULT),
		.access = SNDRV_CTL_ELEM_ACCESS_READWRITE,
		.info = q10_iec958_info, .get = q10_iec958_get, .put = q10_iec958_put,
	},
	{
		.iface = SNDRV_CTL_ELEM_IFACE_PCM,
		.name = SNDRV_CTL_NAME_IEC958("", PLAYBACK, MASK),
		.access = SNDRV_CTL_ELEM_ACCESS_READ,
		.info = q10_iec958_info, .get = q10_iec958_mask_get,
	},
};

/* ---------------------------------------------------------------- ALSA */

static const struct snd_pcm_hardware q10_hw = {
	.info = SNDRV_PCM_INFO_MMAP | SNDRV_PCM_INFO_MMAP_VALID | SNDRV_PCM_INFO_INTERLEAVED |
		SNDRV_PCM_INFO_BLOCK_TRANSFER,
	.formats = SNDRV_PCM_FMTBIT_S16_LE,
	.rates = SNDRV_PCM_RATE_48000,
	.rate_min = 48000, .rate_max = 48000,
	.channels_min = 2, .channels_max = 2,
	.buffer_bytes_max = RING_MAX,
	.period_bytes_min = 1024, .period_bytes_max = RING_MAX / 2,
	.periods_min = 2, .periods_max = 64,
};

/* Write pointer = ALSA's appl_ptr, kept >= GAP bytes behind the read pointer, 32-B aligned. */
static void q10_update_wptr(struct q10 *q, unsigned int rptr)
{
	struct snd_pcm_runtime *rt = q->ss->runtime;
	unsigned int appl = frames_to_bytes(rt, rt->control->appl_ptr % rt->buffer_size);
	unsigned int queued = (appl + q->buf_bytes - rptr) % q->buf_bytes;
	unsigned int w;
	snd_pcm_sframes_t avail = snd_pcm_playback_hw_avail(rt);
	/*
	 * Free-run (stop_threshold at the boundary): the client — dmix, PipeWire — writes straight into
	 * the mmap ring ahead of the hardware and never moves appl_ptr, so "up to appl" would be EMPTY
	 * forever and the DMA would never start (hw_ptr stuck at 0, measured 2026-10-13). Such a
	 * client expects the hardware to loop the whole ring, so treat the ring as always full.
	 */
	bool free_run = rt->stop_threshold >= rt->boundary;

	if (free_run || avail >= rt->buffer_size || queued + GAP >= q->buf_bytes)
		w = (rptr + q->buf_bytes - GAP) % q->buf_bytes;	/* full: stop GAP short */
	else
		w = appl;
	w &= ~31u;
	for (int i = 0; i < 3; i++)
		if (outputs & BIT(i))
			writel(w, q->aiao + port_of[i] + P_BUFF_WPTR);
}


static unsigned int q10_rptr(struct q10 *q)
{
	int i;

	for (i = 0; i < 3; i++)
		if (outputs & BIT(i))
			return readl(q->aiao + port_of[i] + P_BUFF_RPTR) & 0xffffff;
	return 0;
}

static enum hrtimer_restart q10_tick(struct hrtimer *t)
{
	struct q10 *q = container_of(t, struct q10, timer);
	unsigned int rptr, period;
	bool elapsed = false;
	unsigned long flags;

	spin_lock_irqsave(&q->lock, flags);
	if (!q->running) {
		spin_unlock_irqrestore(&q->lock, flags);
		return HRTIMER_NORESTART;
	}
	rptr = q10_rptr(q);
	period = rptr / q->period_bytes;
	if (period != q->last_period) {
		q->last_period = period;
		elapsed = true;
	}
	q10_update_wptr(q, rptr);
	spin_unlock_irqrestore(&q->lock, flags);
	if (elapsed)
		snd_pcm_period_elapsed(q->ss);
	hrtimer_forward_now(t, q->tick);
	return HRTIMER_RESTART;
}

static int q10_open(struct snd_pcm_substream *ss)
{
	struct q10 *q = snd_pcm_substream_chip(ss);
	int err;

	ss->runtime->hw = q10_hw;
	/* AIAO: buffer and period in 128-byte units (32 frames of S16 stereo). */
	err = snd_pcm_hw_constraint_step(ss->runtime, 0, SNDRV_PCM_HW_PARAM_PERIOD_BYTES, 128);
	if (err < 0)
		return err;
	err = snd_pcm_hw_constraint_step(ss->runtime, 0, SNDRV_PCM_HW_PARAM_BUFFER_BYTES, 128);
	if (err < 0)
		return err;
	err = snd_pcm_hw_constraint_integer(ss->runtime, SNDRV_PCM_HW_PARAM_PERIODS);
	if (err < 0)
		return err;
	q->ss = ss;
	return 0;
}

static int q10_close(struct snd_pcm_substream *ss)
{
	struct q10 *q = snd_pcm_substream_chip(ss);

	hrtimer_cancel(&q->timer);
	q->ss = NULL;
	return 0;
}

static int q10_prepare(struct snd_pcm_substream *ss)
{
	struct q10 *q = snd_pcm_substream_chip(ss);
	struct snd_pcm_runtime *rt = ss->runtime;

	q->buf_bytes = snd_pcm_lib_buffer_bytes(ss);
	q->period_bytes = snd_pcm_lib_period_bytes(ss);
	q->last_period = 0;
	/* poll 4x per period: the pointer granularity ALSA sees is a quarter period */
	q->tick = ns_to_ktime(div_u64((u64)rt->period_size * NSEC_PER_SEC, rt->rate * 4));
	for (int i = 0; i < 3; i++)
		if (outputs & BIT(i))
			port_ring(q->aiao + port_of[i], rt->dma_addr, q->buf_bytes, q->period_bytes);
	return 0;
}

static int q10_trigger(struct snd_pcm_substream *ss, int cmd)
{
	struct q10 *q = snd_pcm_substream_chip(ss);
	unsigned long flags;

	switch (cmd) {
	case SNDRV_PCM_TRIGGER_START:
		spin_lock_irqsave(&q->lock, flags);
		q10_apply_iec958(q);
		q10_update_wptr(q, 0);			/* prime with what ALSA already wrote */
		if (outputs & 1)
			rmw(q->aiao + PORT_TX2 + P_DSP_CTRL, DSP_TX_ENABLE, DSP_TX_ENABLE);
		if (outputs & 4)
			rmw(q->aiao + PORT_TX3 + P_DSP_CTRL, DSP_TX_ENABLE, DSP_TX_ENABLE);
		if (outputs & 2) {
			rmw(q->aiao + PORT_SPDIF1 + P_DSP_CTRL, DSP_TX_ENABLE, DSP_TX_ENABLE);
			writel(0x2010, q->aiao + SPDIFER1 + SPDIF_CS3);
			rmw(q->aiao + SPDIFER1 + SPDIF_CTRL, BIT(0), BIT(0));
		}
		q->running = true;
		spin_unlock_irqrestore(&q->lock, flags);
		hrtimer_start(&q->timer, q->tick, HRTIMER_MODE_REL);
		return 0;
	case SNDRV_PCM_TRIGGER_STOP:
		spin_lock_irqsave(&q->lock, flags);
		q->running = false;
		if (outputs & 1)
			port_stop(q->aiao + PORT_TX2);
		if (outputs & 4)
			port_stop(q->aiao + PORT_TX3);
		if (outputs & 2) {
			port_stop(q->aiao + PORT_SPDIF1);
			rmw(q->aiao + SPDIFER1 + SPDIF_CTRL, BIT(0), 0);
		}
		spin_unlock_irqrestore(&q->lock, flags);
		return 0;
	}
	return -EINVAL;
}

static snd_pcm_uframes_t q10_pointer(struct snd_pcm_substream *ss)
{
	struct q10 *q = snd_pcm_substream_chip(ss);

	return bytes_to_frames(ss->runtime, q10_rptr(q) % q->buf_bytes);
}

static const struct snd_pcm_ops q10_ops = {
	.open = q10_open,
	.close = q10_close,
	.prepare = q10_prepare,
	.trigger = q10_trigger,
	.pointer = q10_pointer,
};

/* ---------------------------------------------------------------- probe */

static int q10_probe(struct platform_device *pdev)
{
	struct device *dev = &pdev->dev;
	struct snd_card *card;
	struct snd_pcm *pcm;
	struct q10 *q;
	int err;

	err = dma_coerce_mask_and_coherent(dev, DMA_BIT_MASK(32));
	if (err)
		return err;
	err = snd_devm_card_new(dev, SNDRV_DEFAULT_IDX1, "Q10", THIS_MODULE, sizeof(*q), &card);
	if (err)
		return err;
	q = card->private_data;
	q->card = card;
	spin_lock_init(&q->lock);
	/* consumer PCM, 48 kHz: exactly what the recipe programs (copy-prohibited AES0 = 0, AES3 = 0x02) */
	q->iec958[3] = IEC958_AES3_CON_FS_48000;
	hrtimer_setup(&q->timer, q10_tick, CLOCK_MONOTONIC, HRTIMER_MODE_REL);

	q->aiao = devm_ioremap(dev, AIAO_BASE, AIAO_SIZE);
	q->crg = devm_ioremap(dev, CRG_BASE, SZ_4K);
	q->peri = devm_ioremap(dev, PERI_BASE, SZ_4K);
	q->hdmi = devm_ioremap(dev, HDMI_BASE, HDMI_SIZE);
	if (!q->aiao || !q->crg || !q->peri || !q->hdmi)
		return -ENOMEM;

	dev_info(dev, "EPLL ctrl0 0x%08x ctrl1 0x%08x, CRG70 0x%08x, mclk_div 0x%08x\n",
		 readl(q->crg + CRG_EPLL0), readl(q->crg + CRG_EPLL1),
		 readl(q->crg + CRG70_AIAO), mclk_div);
	err = aiao_power_on(q);
	if (err) {
		dev_err(dev, "AIAO power-on failed (%d), CRG70 0x%08x STATUS 0x%08x\n", err,
			readl(q->crg + CRG70_AIAO), readl(q->aiao + AIAO_STATUS));
		return err;
	}
	dev_info(dev, "AIAO up: capability 0x%08x version 0x%08x CRG70 0x%08x\n",
		 readl(q->aiao + AIAO_HW_CAPABILITY), readl(q->aiao + 0x24),
		 readl(q->crg + CRG70_AIAO));
	if (outputs & 1) {
		tx2_setup(q);
		dac_power_up(q);
		dev_info(dev, "DAC: ADAC0 0x%08x ADAC1 0x%08x ADAC2 0x%08x CRG69 0x%08x\n",
			 readl(q->peri + PERI_ADAC0), readl(q->peri + PERI_ADAC1),
			 readl(q->peri + PERI_ADAC2), readl(q->crg + CRG69_ADAC));
	}
	if (outputs & 2)
		spdif_setup(q);
	if (outputs & 4) {
		tx3_setup(q);
		err = hdmi_audio_enable(q);
		if (err) {
			dev_warn(dev, "HDMI audio not enabled (%d: link in DVI mode?) — RCA/S/PDIF only\n", err);
			outputs &= ~4;
		} else {
			dev_info(dev, "HDMI audio on: TX3 -> HDMI, N=6144, audio InfoFrame enabled\n");
		}
	}

	err = snd_pcm_new(card, "Q10 AIAO", 0, 1, 0, &pcm);
	if (err)
		return err;
	pcm->private_data = q;
	strscpy(pcm->name, "Q10 RCA + S/PDIF + HDMI", sizeof(pcm->name));
	snd_pcm_set_ops(pcm, SNDRV_PCM_STREAM_PLAYBACK, &q10_ops);
	snd_pcm_set_managed_buffer_all(pcm, SNDRV_DMA_TYPE_DEV, dev, RING_MAX, RING_MAX);
	for (int i = 0; i < ARRAY_SIZE(q10_iec958_ctls); i++) {
		err = snd_ctl_add(card, snd_ctl_new1(&q10_iec958_ctls[i], q));
		if (err < 0)
			return err;
	}
	q->on = outputs & 7;		/* every present port starts audible, as before the switches */
	for (int i = 0; i < ARRAY_SIZE(q10_switch_ctls); i++) {
		if (!(outputs & BIT(i)))
			continue;
		err = snd_ctl_add(card, snd_ctl_new1(&q10_switch_ctls[i], q));
		if (err < 0)
			return err;
	}

	strscpy(card->driver, "q10_aiao", sizeof(card->driver));
	strscpy(card->shortname, "Q10 Audio", sizeof(card->shortname));
	snprintf(card->longname, sizeof(card->longname),
		 "HiMedia Q10 Pro AIAO (RCA=%s, S/PDIF=%s, HDMI=%s)",
		 (outputs & 1) ? "on" : "off", (outputs & 2) ? "on" : "off",
		 (outputs & 4) ? "on" : "off");
	err = snd_card_register(card);
	if (err)
		return err;
	platform_set_drvdata(pdev, q);
	return 0;
}

static void q10_remove(struct platform_device *pdev)
{
	struct q10 *q = platform_get_drvdata(pdev);

	if (q)
		hrtimer_cancel(&q->timer);
}

static struct platform_driver q10_driver = {
	.probe = q10_probe,
	.remove = q10_remove,
	.driver = { .name = "q10-aiao" },
};

static struct platform_device *q10_pdev;

static int __init q10_init(void)
{
	int err = platform_driver_register(&q10_driver);

	if (err)
		return err;
	q10_pdev = platform_device_register_simple("q10-aiao", -1, NULL, 0);
	if (IS_ERR(q10_pdev)) {
		platform_driver_unregister(&q10_driver);
		return PTR_ERR(q10_pdev);
	}
	return 0;
}

static void __exit q10_exit(void)
{
	platform_device_unregister(q10_pdev);
	platform_driver_unregister(&q10_driver);
}

module_init(q10_init);
module_exit(q10_exit);
MODULE_DESCRIPTION("HiMedia Q10 Pro (Hi3798CV200) AIAO playback: internal DAC + S/PDIF");
MODULE_LICENSE("GPL");
