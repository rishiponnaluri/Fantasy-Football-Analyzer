"""Fantasy-team image identity; private ESPN uploads stay server-side."""
from urllib.parse import urlparse
import requests
from espn_service import APIError


def is_private_upload(url):
    parsed = urlparse(str(url or ''))
    return (parsed.scheme == 'https' and parsed.hostname == 'mystique-api.fantasy.espn.com'
            and parsed.path.startswith('/apis/v1/domains/lm/images/') and not parsed.username
            and parsed.port in (None, 443))


def image_fields(team):
    # espn-api maps the observed ESPN teams[].logo field to Team.logo_url.
    url = getattr(team, 'logo_url', None) or getattr(team, 'logo', None)
    if is_private_upload(url):
        proxy = f'/api/backend/teams/{team.team_id}/image'
        return {'team_logo_url': proxy, 'custom_team_logo_url': proxy,
                'default_team_logo_url': None, 'team_image_source': 'ESPN teams[].logo (CUSTOM_UPLOAD)'}
    return {'team_logo_url': url, 'custom_team_logo_url': None,
            'default_team_logo_url': url, 'team_image_source': 'ESPN teams[].logo' if url else None}


def team_image(service, team_id):
    team = service.teams.get(team_id)
    url = getattr(team, 'logo_url', None) if team else None
    if not is_private_upload(url):
        raise APIError(404, 'team_image_unavailable', 'Fantasy team image unavailable.')
    def load():
        # No caller-supplied URL, redirects, or credentials in the response.
        try:
            response = requests.get(url, cookies=service.league.espn_request.cookies,
                                    timeout=8, allow_redirects=False, stream=True)
            with response:
                content_type = response.headers.get('Content-Type', '').split(';')[0].lower()
                if response.status_code != 200 or content_type not in {'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'}:
                    raise ValueError('Image unavailable')
                data = bytearray()
                for block in response.iter_content(65536):
                    data.extend(block)
                    if len(data) > 2_000_000:
                        raise ValueError('Image too large')
                return bytes(data), content_type
        except (requests.RequestException, ValueError):
            raise APIError(502, 'team_image_unavailable', 'Fantasy team image unavailable.') from None
    return service.memoized(('fantasy_team_image', team_id, url), 300, load)
