'use client';

import { useState } from 'react';
import { categoryImageSrc } from './category-art';
import { iconByKey, iconForCategory } from './landing-icons';

type CategoryVisualProps = {
  imageUrl?: string | null;
  /** Falls back to the packaged handoff illustration for this slug. */
  slug?: string | null;
  iconKey?: string | null;
  name: string;
  iconSize?: number;
  imgClassName?: string;
  iconClassName?: string;
  iconWrapperClassName?: string;
  alt?: string;
};

export function CategoryVisual({
  imageUrl,
  slug,
  iconKey,
  name,
  iconSize = 22,
  imgClassName,
  iconClassName,
  iconWrapperClassName,
  alt,
}: CategoryVisualProps) {
  const [imageBroken, setImageBroken] = useState(false);
  const src = categoryImageSrc(imageUrl, slug);

  if (src && !imageBroken) {
    return (
      <img
        src={src}
        alt={alt ?? ''}
        className={imgClassName}
        loading="lazy"
        onError={() => setImageBroken(true)}
      />
    );
  }

  const FromKey = iconByKey(iconKey);
  const Icon = FromKey ?? iconForCategory(name);

  return (
    <span className={iconWrapperClassName} aria-hidden="true">
      <Icon size={iconSize} className={iconClassName} />
    </span>
  );
}

type CategoryCoverProps = {
  coverImageUrl: string;
  alt?: string;
  className?: string;
};

export function CategoryCover({ coverImageUrl, alt, className }: CategoryCoverProps) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return null;
  }

  return (
    <img
      src={coverImageUrl}
      alt={alt ?? ''}
      className={className}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}
