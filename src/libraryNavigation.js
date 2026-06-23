export function getAdjacentIndex(currentIndex, direction, itemCount) {
  if (itemCount <= 0) return -1;
  if (direction === 0) return currentIndex;
  return (currentIndex + direction + itemCount) % itemCount;
}

export function getWheelDirection(deltaY) {
  if (deltaY > 0) return 1;
  if (deltaY < 0) return -1;
  return 0;
}
