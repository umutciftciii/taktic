import { CampaignChannel, SourceChannel } from '@prisma/client';

/**
 * The channel rule of a campaign version (CMP-006 PR-D, design D25), pure.
 *
 *   version ALL     matches WEB, MOBILE and UNKNOWN — "no channel condition",
 *                   which is what every version before PR-D meant
 *   version WEB     matches WEB only
 *   version MOBILE  matches MOBILE only
 *
 * UNKNOWN is fail-closed for a channel-targeted version: a version that
 * discriminates by channel cannot grant for an event whose channel nobody
 * knows — an event from before the columns existed, a purchase an operator
 * opened for a business, a proof raised by a path that records no channel.
 * Counting it in would hand a WEB-only promotion to anything that simply
 * failed to say where it came from.
 *
 * A mismatch is a business outcome (`CHANNEL_MISMATCH`, reason
 * `SOURCE_<channel>`), never an error: the event is not this version's, and
 * nothing about it is retried.
 */

export type ChannelVerdict = { matches: true } | { matches: false; reasonCode: ChannelMismatchReason };

export type ChannelMismatchReason = `SOURCE_${SourceChannel}`;

export function matchChannel(target: CampaignChannel, source: SourceChannel): ChannelVerdict {
  if (target === CampaignChannel.ALL) {
    return { matches: true };
  }
  if (source !== SourceChannel.UNKNOWN && (target as string) === (source as string)) {
    return { matches: true };
  }
  return { matches: false, reasonCode: `SOURCE_${source}` };
}

/** The source channel a WEB/MOBILE target needs a registered writer for; ALL needs none. */
export function requiredSourceChannel(target: CampaignChannel): SourceChannel | null {
  switch (target) {
    case CampaignChannel.ALL:
      return null;
    case CampaignChannel.WEB:
      return SourceChannel.WEB;
    case CampaignChannel.MOBILE:
      return SourceChannel.MOBILE;
  }
}
