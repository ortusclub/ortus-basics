// This script is injected into the LinkedIn page context (main world)
// It monkey-patches fetch() to intercept Sales Navigator API responses

(function () {
  if (window.__ortusInterceptorActive) return;
  window.__ortusInterceptorActive = true;
  window.__ortusInterceptedData = [];

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    // Intercept Sales Navigator search API calls
    if (
      url.includes('/salesApiLeadSearch') ||
      url.includes('/salesApiPeopleSearch') ||
      url.includes('/voyagerSalesSearch') ||
      url.includes('/search/blended')
    ) {
      try {
        const cloned = response.clone();
        const data = await cloned.json();
        const elements =
          data?.data?.searchDashClustersByAll?.elements ||
          data?.elements ||
          data?.data?.elements ||
          [];

        for (const cluster of elements) {
          const items = cluster?.items || cluster?.elements || [cluster];
          for (const item of items) {
            const profile = extractProfile(item);
            if (profile && profile.memberUrn) {
              window.__ortusInterceptedData.push(profile);
            }
          }
        }
      } catch (e) {
        // silently fail — not all responses are JSON
      }
    }

    return response;
  };

  function extractProfile(item) {
    try {
      const entity =
        item?.entityResult ||
        item?.item?.entityResult ||
        item?.entity ||
        item;
      if (!entity) return null;

      const titleText =
        entity?.title?.text ||
        entity?.title ||
        '';
      const subtitleText =
        entity?.primarySubtitle?.text ||
        entity?.subtitle?.text ||
        '';
      const summaryText =
        entity?.summary?.text ||
        entity?.secondarySubtitle?.text ||
        '';

      // Extract member URN from entityUrn or navigationUrl
      let memberUrn = '';
      const entityUrn = entity?.entityUrn || entity?.objectUrn || '';
      const navUrl = entity?.navigationUrl || '';

      if (entityUrn.includes('fsd_salesProfile:')) {
        memberUrn = entityUrn.split('fsd_salesProfile:')[1]?.split(',')[0]?.replace(/[()]/g, '') || '';
      } else if (navUrl.includes('/lead/')) {
        memberUrn = navUrl.split('/lead/')[1]?.split(',')[0]?.split('?')[0] || '';
      }

      // Extract badges
      const badges = entity?.badgeData?.badges || entity?.badges || [];
      const isOpenLink = badges.some(
        (b) => b.type === 'OPEN_LINK' || b.text === 'Open'
      );
      const isPremium = badges.some(
        (b) => b.type === 'PREMIUM' || b.text === 'Premium'
      );

      // Extract profile URL
      let profileUrl = '';
      if (navUrl) {
        try {
          const parsed = new URL(navUrl, 'https://www.linkedin.com');
          profileUrl = parsed.pathname;
        } catch (e) {
          profileUrl = navUrl;
        }
      }

      return {
        memberUrn,
        firstName: '',
        lastName: '',
        fullName: titleText,
        title: subtitleText,
        company: '',
        location: summaryText,
        profileUrl,
        isOpenLink,
        isPremium,
        source: 'interceptor',
      };
    } catch (e) {
      return null;
    }
  }
})();
