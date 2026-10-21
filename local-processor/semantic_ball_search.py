"""Bounded source-video hints for native detail detection, never coordinates."""
import math


def observed_search_region(anchors, time):
    visible = [a for a in anchors if isinstance(a.get('ball'), list)
        and len(a['ball']) == 4 and isinstance(a.get('time'), (int, float))
        and abs(a['time']-time) <= .2]
    if not visible:
        return None
    a = min(visible, key=lambda a: abs(a['time']-time))
    b = a['ball']
    return [b[1]/1000, b[0]/1000, b[3]/1000, b[2]/1000,
        .025+abs(a['time']-time)*.35]


def needs_detail_search(balls, region):
    if region is None:
        return False
    x1,y1,x2,y2,radius = region
    return not any(b.get('confidence', 0) >= .12 and math.hypot(
        max(0, x1-b['cx'], b['cx']-x2),
        max(0, y1-b['cy'], b['cy']-y2)*.6) <= radius for b in balls)
