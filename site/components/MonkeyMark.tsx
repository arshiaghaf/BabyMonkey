type MonkeyMarkProps = {
  className?: string;
  imageSrc: string;
};

export function MonkeyMark({ className, imageSrc }: MonkeyMarkProps) {
  return (
    <span aria-hidden="true" className={className}>
      {/* The source is supplied only by an authorized server response or local preview. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="" height="56" src={imageSrc} width="56" />
    </span>
  );
}
