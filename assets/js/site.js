/*
 * Site-wide behaviour: the light/dark toggle, and preview cards that appear
 * when a visitor hovers a Wikipedia or GitHub repository link.
 */
(function () {
  'use strict';

  var root = document.documentElement;

  // Theme toggle ---------------------------------------------------------------

  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function currentTheme() {
    var chosen = root.getAttribute('data-theme');
    if (chosen === 'light' || chosen === 'dark') return chosen;
    return darkQuery.matches ? 'dark' : 'light';
  }

  function announceTheme() {
    document.dispatchEvent(new CustomEvent('themechange'));
  }

  var toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem('theme', next);
      } catch (e) {}
      announceTheme();
    });
  }
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', announceTheme);

  // Link previews --------------------------------------------------------------

  // Hover cards only make sense with a mouse; touch visitors just follow the link.
  if (!window.fetch || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var SHOW_DELAY = 350;
  var HIDE_DELAY = 180;
  var cache = {};
  var card = null, activeLink = null, showTimer = 0, hideTimer = 0;

  // Work out what a link points at, and where to ask about it.
  function describe(link) {
    var url;
    try {
      url = new URL(link.href);
    } catch (e) {
      return null;
    }
    var match;
    if (/(^|\.)wikipedia\.org$/.test(url.hostname) && (match = url.pathname.match(/^\/wiki\/([^/]+)$/))) {
      return {
        key: 'wiki:' + url.hostname + '/' + match[1],
        api: 'https://' + url.hostname + '/api/rest_v1/page/summary/' + match[1],
        read: function (data) {
          if (!data.extract || data.type === 'disambiguation') return null;
          return {
            source: 'Wikipedia',
            title: data.title,
            desc: data.description || '',
            text: data.extract,
            thumb: data.thumbnail ? data.thumbnail.source : ''
          };
        }
      };
    }
    if (url.hostname === 'github.com' && (match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/))) {
      return {
        key: 'repo:' + match[1] + '/' + match[2],
        api: 'https://api.github.com/repos/' + match[1] + '/' + match[2],
        read: function (data) {
          if (!data.full_name || !data.description) return null;
          var facts = [];
          if (data.language) facts.push(data.language);
          if (data.pushed_at) facts.push('updated ' + data.pushed_at.slice(0, 10));
          return {
            source: 'GitHub',
            title: data.full_name,
            desc: facts.join(' · '),
            text: data.description,
            thumb: ''
          };
        }
      };
    }
    return null;
  }

  // Resolves to the card's contents, or null when there is nothing to show.
  function load(info) {
    if (!cache[info.key]) {
      cache[info.key] = fetch(info.api, { headers: { Accept: 'application/json' } })
        .then(function (response) {
          return response.ok ? response.json() : null;
        })
        .then(function (data) {
          return data ? info.read(data) : null;
        })
        .catch(function () {
          return null;
        });
    }
    return cache[info.key];
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    activeLink = null;
    if (card) {
      card.remove();
      card = null;
    }
  }

  function show(link, data) {
    if (card) card.remove();
    card = element('div', 'preview');
    card.setAttribute('role', 'tooltip');
    if (data.thumb) {
      var img = element('img', 'preview-thumb');
      img.src = data.thumb;
      img.alt = '';
      card.appendChild(img);
    }
    card.appendChild(element('p', 'preview-source', data.source));
    card.appendChild(element('p', 'preview-title', data.title));
    if (data.desc) card.appendChild(element('p', 'preview-desc', data.desc));
    card.appendChild(element('p', 'preview-text', data.text));
    card.addEventListener('mouseenter', function () {
      clearTimeout(hideTimer);
    });
    card.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(card);

    // Below the link when there is room, otherwise above it.
    var rect = link.getBoundingClientRect();
    // clientWidth and clientHeight leave out the scrollbars, so the card cannot widen the page.
    var gap = 8, margin = 12;
    var viewWidth = root.clientWidth, viewHeight = root.clientHeight;
    var left = Math.min(Math.max(rect.left, margin), viewWidth - card.offsetWidth - margin);
    var top = rect.bottom + gap;
    if (top + card.offsetHeight > viewHeight - margin && rect.top - gap - card.offsetHeight > margin) {
      top = rect.top - gap - card.offsetHeight;
    }
    card.style.left = Math.max(left, margin) + window.scrollX + 'px';
    card.style.top = top + window.scrollY + 'px';
  }

  function scheduleShow(link) {
    var info = describe(link);
    if (!info) return;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    activeLink = link;
    showTimer = setTimeout(function () {
      load(info).then(function (data) {
        if (data && activeLink === link) show(link, data);
      });
    }, SHOW_DELAY);
  }

  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  function linkFrom(event) {
    var target = event.target;
    return target && target.closest ? target.closest('.prose a[href]') : null;
  }

  document.addEventListener('mouseover', function (event) {
    var link = linkFrom(event);
    if (link && link !== activeLink) scheduleShow(link);
    else if (link) clearTimeout(hideTimer);
  });
  document.addEventListener('mouseout', function (event) {
    if (linkFrom(event)) scheduleHide();
  });
  document.addEventListener('focusin', function (event) {
    var link = linkFrom(event);
    if (link) scheduleShow(link);
  });
  document.addEventListener('focusout', function (event) {
    if (linkFrom(event)) scheduleHide();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') hide();
  });
})();
