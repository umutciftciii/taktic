'use client';

import { useState } from 'react';
import { iconByKey, iconForCategory } from './landing-icons';

type CategoryVisualProps = {
  imageUrl?: string | null;
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
  iconKey,
  name,
  iconSize = 22,
  imgClassName,
  iconClassName,
  iconWrapperClassName,
  alt,
}: CategoryVisualProps) {
  const [imageBroken, setImageBroken] = useState(false);

  if (imageUrl && !imageBroken) {
    return (
      <img
        src={imageUrl}
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
