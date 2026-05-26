import { APP_LOGO_SRC, APP_NAME } from '@/lib/app-brand'
import { cn } from '@/lib/utils'

interface AppLogoProps {
  size?: number
  className?: string
}

export function AppLogo({ size = 32, className }: AppLogoProps) {
  return (
    <img
      src={APP_LOGO_SRC}
      alt={APP_NAME}
      width={size}
      height={size}
      className={cn('object-cover rounded-xl shrink-0', className)}
      draggable={false}
    />
  )
}
