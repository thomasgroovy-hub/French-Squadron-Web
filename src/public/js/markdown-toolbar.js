/*
 * Barre de mise en forme façon Discord pour les champs de texte.
 *
 * Elle est entièrement optionnelle : sans ce fichier, les champs restent de
 * simples zones de texte et le markdown se saisit à la main. Rien ici n'est
 * nécessaire pour valider un formulaire, donc chaque étape est câblée pour
 * échouer en silence plutôt que de casser la page.
 *
 * Le script n'agit que sur les champs portant `data-md-field` : c'est une liste
 * blanche, donc un champ ajouté plus tard sans cet attribut n'expose pas de
 * barre par accident, et un champ qui n'accepte pas de markdown (une option de
 * liste déroulante, une URL d'image, une date) ne peut pas en recevoir.
 */
(function () {
  'use strict';

  var FIELD_SELECTOR = '[data-md-field]';

  /* Chaque outil décrit son encadrement. `placeholder` est le texte inséré à la
     place d'une sélection vide : il reste sélectionné, donc l'utilisateur tape
     directement par-dessus. */
  var TOOLS = [
    { id: 'bold', label: 'Gras', hint: 'Gras (Ctrl+B)', wrap: ['**', '**'], placeholder: 'texte en gras' },
    { id: 'italic', label: 'Italique', hint: 'Italique (Ctrl+I)', wrap: ['*', '*'], placeholder: 'texte en italique' },
    { id: 'underline', label: 'Souligné', hint: 'Souligné (Ctrl+U)', wrap: ['__', '__'], placeholder: 'texte souligné' },
    { id: 'strike', label: 'Barré', hint: 'Barré', wrap: ['~~', '~~'], placeholder: 'texte barré' },
    { id: 'spoiler', label: 'Spoiler', hint: 'Masquer le texte', wrap: ['||', '||'], placeholder: 'texte masqué' },
    { id: 'quote', label: 'Citation', hint: 'Citation', line: '> ' },
    { id: 'code', label: 'Code', hint: 'Code en ligne', wrap: ['`', '`'], placeholder: 'code' },
    { id: 'link', label: 'Lien', hint: 'Lien', link: true }
  ];

  var bar = null;
  /* Le champ suivi qui a le focus, et le champ auquel la barre est accrochée.
     Les deux diffèrent : une barre n'apparaît que sur une sélection, alors que
     les raccourcis clavier doivent rester actifs dans un champ sans sélection —
     c'est même là qu'ils sont les plus utiles, pour insérer un mot prêt à
     remplir. Confondre les deux rendrait le raccourci mort et ferait tomber la
     barre au moment précis où l'on vient de s'en servir. */
  var focusedField = null;
  var anchoredField = null;

  /* ---------------------------------------------------------------- helpers */

  function isTextField(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!node.matches || !node.matches(FIELD_SELECTOR)) return false;
    if (node.tagName === 'TEXTAREA') return true;
    if (node.tagName !== 'INPUT') return false;
    var type = (node.getAttribute('type') || 'text').toLowerCase();
    return type === 'text' || type === 'search' || type === '';
  }

  /* Une zone de texte ou un champ texte a toujours `selectionStart`. C'est la
     seule source de vérité utilisée ici : aucun `window.getSelection()`, donc
     aucune dépendance à la façon dont le navigateur expose le texte d'un
     formulaire. */
  function hasSelection(field) {
    try {
      return field.selectionEnd > field.selectionStart;
    } catch (error) {
      return false;
    }
  }

  /* `setRangeText` remplace l'intervalle sélectionné en une opération ; la
     repli manuelle ne s'exécute que sur un navigateur qui l'ignore. */
  function replaceRange(field, text, start, end, selectStart, selectEnd) {
    if (typeof field.setRangeText === 'function') {
      field.setRangeText(text, start, end, 'end');
    } else {
      field.value = field.value.slice(0, start) + text + field.value.slice(end);
    }
    field.setSelectionRange(selectStart, selectEnd);
  }

  /* Le clic sur un bouton vole le focus au champ, et avec lui la sélection. On
     l'empêche donc au `mousedown` : le clic arrive quand même, la sélection
     reste en place. Sans cela, la barre se refermerait sous le pointeur. */
  function swallowFocus(event) {
    event.preventDefault();
  }

  /* ------------------------------------------------------------------ outils */

  /* Un marqueur d'un seul caractère peut être le morceau d'un délimiteur plus
     long : le `*` d'un `**`. Sans cette garde, demander l'italique sur un texte
     déjà en gras détecterait les `**` comme des italiques et les déferait — le
     clic aurait alors l'air de ne rien faire. On exige donc qu'aucun caractère
     identique ne borde le marqueur, dans un sens comme dans l'autre. */
  function markerMatches(value, at, marker, forward) {
    if (forward) {
      if (value.slice(at, at + marker.length) !== marker) return false;
      return marker.length > 1 || value[at + marker.length] !== marker;
    }
    if (value.slice(at - marker.length, at) !== marker) return false;
    return marker.length > 1 || value[at - marker.length - 1] !== marker;
  }

  /* Retire les marqueurs immédiatement autour de la sélection, ou autour de la
     sélection elle-même si elle les contient : un second clic sur le même bouton
     retire donc la mise en forme au lieu de l'empiler. Dans tous les cas la
     sélection repart sur le texte nu, ce qui garde la barre affichée et permet
     d'enchaîner un second formatage, ou de l'annuler. */
  function applyWrap(field, before, after, placeholder) {
    var start = field.selectionStart;
    var end = field.selectionEnd;
    var value = field.value;
    var selected = value.slice(start, end);

    if (!selected) {
      var from = start + before.length;
      replaceRange(field, before + placeholder + after, start, end, from, from + placeholder.length);
      return;
    }

    if (selected.length >= before.length + after.length
      && selected.slice(0, before.length) === before
      && selected.slice(selected.length - after.length) === after
      && (before.length > 1 || value[start - 1] !== before)
      && (after.length > 1 || value[start + selected.length] !== after)) {
      var bare = selected.slice(before.length, selected.length - after.length);
      replaceRange(field, bare, start, end, start, start + bare.length);
      return;
    }

    if (markerMatches(value, start, before, false) && markerMatches(value, end, after, true)) {
      var at = start - before.length;
      field.value = value.slice(0, at) + selected + value.slice(end + after.length);
      field.setSelectionRange(at, at + selected.length);
      return;
    }

    var inner = start + before.length;
    replaceRange(field, before + selected + after, start, end, inner, inner + selected.length);
  }

  /* Un préfixe de ligne n'enveloppe rien : il s'applique à chaque début de
     ligne touchée, et se retire ligne par ligne. */
  function applyLinePrefix(field, prefix) {
    var value = field.value;
    var start = field.selectionStart;
    var end = field.selectionEnd;
    var from = value.lastIndexOf('\n', start - 1) + 1;
    var lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    var lines = value.slice(from, lineEnd).split('\n');
    var alreadyPrefixed = lines.every(function (line) {
      return !line.trim() || line.slice(0, prefix.length) === prefix;
    });

    var result = lines.map(function (line) {
      if (!line.trim()) return line;
      if (alreadyPrefixed) return line.slice(0, prefix.length) === prefix ? line.slice(prefix.length) : line;
      return prefix + line;
    }).join('\n');

    field.value = value.slice(0, from) + result + value.slice(lineEnd);
    field.setSelectionRange(from, from + result.length);
  }

  /* Un lien a besoin d'une cible : on insère la forme complète et on laisse
     l'URL sélectionnée, que l'utilisateur remplace en tapant. */
  function applyLink(field) {
    var start = field.selectionStart;
    var end = field.selectionEnd;
    var selected = field.value.slice(start, end) || 'lien';
    var urlFrom = start + selected.length + 3;
    replaceRange(field, '[' + selected + '](https://)', start, end, urlFrom, urlFrom + 'https://'.length);
  }

  function runTool(tool) {
    var field = focusedField;
    if (!field) return;
    if (tool.link) applyLink(field);
    else if (tool.line) applyLinePrefix(field, tool.line);
    else applyWrap(field, tool.wrap[0], tool.wrap[1], tool.placeholder);
    /* Le champ vient d'être modifié : sa nouvelle sélection décide de l'affichage,
       et le focus est rendu au clavier pour que l'on puisse enchaîner. */
    sync(field);
    field.focus();
  }

  /* ------------------------------------------------------------------- barre */

  function buildBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'md-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Mise en forme');
    bar.setAttribute('aria-hidden', 'true');
    bar.hidden = true;

    TOOLS.forEach(function (tool) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'md-tool';
      button.title = tool.hint;
      button.setAttribute('aria-label', tool.label);
      /* Gras, italique et souligné sont rendus avec leur balise : le glyphe se
         lit alors comme le raccourci qu'il représente, sans image à charger. */
      if (tool.id === 'bold') button.innerHTML = '<strong>B</strong>';
      else if (tool.id === 'italic') button.innerHTML = '<em>I</em>';
      else if (tool.id === 'underline') button.innerHTML = '<u>U</u>';
      else if (tool.id === 'strike') button.innerHTML = '<s>S</s>';
      else if (tool.id === 'spoiler') button.textContent = '?';
      else if (tool.id === 'quote') button.textContent = '❝';
      else if (tool.id === 'code') button.textContent = '‹›';
      else if (tool.id === 'link') button.textContent = '↗';
      button.addEventListener('mousedown', swallowFocus);
      button.addEventListener('click', function (event) {
        event.preventDefault();
        runTool(tool);
      });
      bar.appendChild(button);
    });

    bar.addEventListener('mousedown', swallowFocus);
    document.body.appendChild(bar);
    return bar;
  }

  /* ---------------------------------------------------------------- mesure */

  /*
   * L'API Selection ne voit pas la sélection d'un <textarea> ou d'un <input> :
   * le navigateur ne la considère pas comme une sélection de document, si bien
   * que `window.getSelection()` reste vide et qu'aucune méthode ne donne le
   * rectangle des caractères surlignés. Les API de caret (`caretRangeFromPoint`)
   * ne comblent pas le trou : elles renvoient une plage *collapsed*, dont le
   * rectangle est vide.
   *
   * On mesure donc le texte pour de vrai : le contenu du champ est recopié dans
   * un <div> miroir hors écran, dimensionné et typé à l'identique, et un <span>
   * encadre exactement la sélection. Les coordonnées de ce span, ramenées à
   * l'origine du miroir puis du champ, sont celles des caractères affichés. C'est
   * la seule façon d'obtenir la position réelle du texte sans dépendre d'une
   * coordonnée exposée par le navigateur.
   */
  var mirror = null;
  var MIRROR_PROPERTIES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'fontStretch', 'letterSpacing', 'lineHeight', 'textTransform', 'textIndent',
    'textAlign', 'direction', 'wordSpacing', 'tabSize', 'fontKerning',
    'fontFeatureSettings', 'fontVariantLigatures', 'paddingTop', 'paddingRight',
    'paddingBottom', 'paddingLeft'
  ];

  function buildMirror() {
    if (mirror) return mirror;
    mirror = document.createElement('div');
    mirror.className = 'md-mirror';
    /* `visibility` plutôt que `display: none` : un élément non affiché n'a pas de
       boîte, donc aucune mesure ne serait possible. */
    mirror.setAttribute('aria-hidden', 'true');
    document.body.appendChild(mirror);
    return mirror;
  }

  function syncMirror(field) {
    var style = window.getComputedStyle(field);
    var box = buildMirror();
    MIRROR_PROPERTIES.forEach(function (name) {
      box.style[name] = style[name];
    });
    box.style.width = field.clientWidth + 'px';
    box.style.height = field.clientHeight + 'px';
    /* `wrap="off"` désactive le retour à la ligne : le miroir doit suivre, sinon
       les lignes se décalent et le rectangle mesuré ne correspond plus à rien. */
    box.style.whiteSpace = field.wrap === 'off' ? 'pre' : 'pre-wrap';
  }

  /* Rectangle de la sélection, en coordonnées de la fenêtre. `null` si la
     mesure est impossible, et l'appelant retombe alors sur le champ entier. */
  function selectionRect(field) {
    var start = field.selectionStart;
    var end = field.selectionEnd;
    if (end <= start) return null;

    var box = buildMirror();
    syncMirror(field);

    var mark = document.createElement('span');
    mark.className = 'md-mirror-mark';
    mark.textContent = field.value.slice(start, end);
    box.textContent = '';
    box.appendChild(document.createTextNode(field.value.slice(0, start)));
    box.appendChild(mark);
    box.appendChild(document.createTextNode(field.value.slice(end)));

    var marked = mark.getBoundingClientRect();
    if (!marked.width && !marked.height) return null;
    var origin = box.getBoundingClientRect();
    var fieldBox = field.getBoundingClientRect();
    /* Le miroir part du début du texte, la fenêtre montre la partie déjà
       défilée : le décalage du défilement est retranché, sinon la barre suivrait
       le haut du champ au lieu du texte surligné. */
    return {
      top: marked.top - origin.top + fieldBox.top - field.scrollTop,
      bottom: marked.bottom - origin.top + fieldBox.top - field.scrollTop,
      left: marked.left - origin.left + fieldBox.left - field.scrollLeft,
      right: marked.right - origin.left + fieldBox.left - field.scrollLeft
    };
  }

  function anchorRect() {
    var field = anchoredField;
    if (!field) return null;
    return selectionRect(field) || field.getBoundingClientRect();
  }

  function position() {
    if (!bar || !anchoredField) return;
    var rect = anchorRect();
    if (!rect) return;

    var width = bar.offsetWidth || 240;
    var height = bar.offsetHeight || 34;
    var margin = 8;
    /* Au-dessus du texte surligné, et centré dessus comme le fait Discord. */
    var top = rect.top - height - margin;
    /* Pas de place au-dessus : on passe en dessous plutôt que de sortir de
       l'écran. */
    if (top < margin) top = rect.bottom + margin;
    var left = (rect.left + rect.right) / 2 - width / 2;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;

    bar.style.top = Math.round(top) + 'px';
    bar.style.left = Math.round(left) + 'px';
  }

  function show(field) {
    buildBar();
    anchoredField = field;
    bar.hidden = false;
    bar.setAttribute('aria-hidden', 'false');
    /* Premier positionnement sans attendre : la barre ne doit pas clignoter à
       l'ancien endroit avant d'être replacée. */
    position();
  }

  /* Mesurer la sélection force une mise en page, et `selectionchange` se répète à
     chaque pixel de glissement. Regrouper les mesures sur la frame suivante
     évite de recalculer une position qui sera de toute façon abandonnée. */
  var positionFrame = 0;
  function schedulePosition() {
    if (positionFrame || !window.requestAnimationFrame) {
      position();
      return;
    }
    positionFrame = window.requestAnimationFrame(function () {
      positionFrame = 0;
      position();
    });
  }

  function hide() {
    if (!bar) return;
    bar.hidden = true;
    bar.setAttribute('aria-hidden', 'true');
    anchoredField = null;
  }

  /* Point d'entrée unique : un champ suivi et une sélection donnent la barre, le
     reste la retire. Appelé à chaque changement de sélection, ce qui couvre la
     souris, le clavier et la sélection programmatique. */
  function sync(field) {
    if (!isTextField(field)) {
      focusedField = null;
      if (anchoredField) hide();
      return;
    }
    focusedField = field;
    if (!hasSelection(field)) {
      if (anchoredField === field) hide();
      return;
    }
    if (anchoredField !== field) show(field);
    else schedulePosition();
  }

  function toolForKey(key) {
    if (key === 'b') return TOOLS[0];
    if (key === 'i') return TOOLS[1];
    if (key === 'u') return TOOLS[2];
    if (key === 'e') return TOOLS[5];
    return null;
  }

  function bind() {
    buildBar();

    document.addEventListener('mouseup', function (event) {
      sync(event.target);
    }, true);

    document.addEventListener('keyup', function (event) {
      sync(event.target);
    });

    /* Le focus est suivi séparément de la sélection : sans cela, le premier
       raccourci d'une session dans un champ vide serait ignoré, faute
       d'événement de sélection déclencheur. */
    document.addEventListener('focusin', function (event) {
      if (isTextField(event.target)) sync(event.target);
      else {
        focusedField = null;
        if (anchoredField) hide();
      }
    });

    document.addEventListener('select', function (event) {
      sync(event.target);
    }, true);

    document.addEventListener('selectionchange', function () {
      /* C'est l'événement qui suit une sélection à la souris comme au clavier ;
         le champ actif est le seul qui puisse en changer l'état. */
      sync(document.activeElement);
    });

    document.addEventListener('focusout', function () {
      /* Les boutons de la barre empêchent le focus au `mousedown`, donc une
         perte de focus ici signifie vraiment qu'on a quitté le champ. Le délai
         laisse passer le `focusin` suivant, qui peut concerner un autre champ. */
      window.setTimeout(function () {
        if (anchoredField && document.activeElement !== anchoredField) hide();
      }, 0);
    });

    document.addEventListener('click', function (event) {
      if (!anchoredField) return;
      if (bar.contains(event.target) || anchoredField.contains(event.target)) return;
      hide();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && anchoredField) {
        hide();
        return;
      }
      if (!focusedField) return;
      /* Un raccourci exige exactement une touche de modificateur : ni aucune,
         ni les deux à la fois. */
      if (event.ctrlKey === event.metaKey) return;
      var tool = toolForKey(String(event.key).toLowerCase());
      if (!tool) return;
      event.preventDefault();
      runTool(tool);
    });

    window.addEventListener('resize', function () {
      if (anchoredField) hide();
    });
    /* `true` pour attraper aussi le défilement d'un conteneur interne, où la
       barre fixe devrait perdre son ancrage. */
    window.addEventListener('scroll', function () {
      if (anchoredField) hide();
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
