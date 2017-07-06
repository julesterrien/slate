
import { Editor, Raw, Plain, Selection, Mark } from '../..'
import Portal from 'react-portal'
import React from 'react'
import initialState from './state.json'
import citations from './citations.json'
import { requestSpellCheck } from './spell-check'
import { debounce, negate } from 'lodash'

const DEFAULT_NODE = 'paragraph'

const SPELL_CHECK_WAIT_TIME_MS = 3000
const SPELL_CHECK_MAX_WAIT_TIME_MS = 15000

// eslint-disable-next-line func-style
const ignoreSuggestion = ({ rule: { id }}) => id === 'EN_QUOTES'

// eslint-disable-next-line func-style
const typeIs = query => ({ type }) => type === query
const typeIsOffset = typeIs('offset')
const typeIsSpelling = typeIs('spelling')

// eslint-disable-next-line func-style
const isErrorIgnored = ({ data }) => data.get('ignored')

// eslint-disable-next-line func-style
const addX = x => y => x + y
const add1 = addX(1)
const sub1 = addX(-1)

// eslint-disable-next-line func-style
const matchesErrorMark = (op, m1) => (m2) => {
  const p1 = m1.data.get('position')
  const p2 = m2.data.get('position')
  const c1 = m1.data.get('message')
  const c2 = m2.data.get('message')
  return c1 === c2 && op(p1) === p2
}

function isSameError(chars, position, mark, op) {
  const character = chars.get(position)
  if (!character) {
    return false
  }
  return character.marks.some(matchesErrorMark(op, mark))
}

function ignoredError(chars, offset, { length, message }) {
  const character = chars.get(offset)
  return character.marks.filter(typeIsSpelling).reduce((memo, mark) => {
    return memo || (
      mark.data.get('message') === message &&
      mark.data.get('ignored')
    )
  }, false)
}

function removeSpellingSuggestion(transform, key, chars, offset, position, length, mark) {
  const base = offset - position

  for (let i = 0; i < length; i++) {
    const character = chars.get(base + i)
    if (character) {
      const remove = character.marks.filter(matchesErrorMark(addX(i - position), mark)).first()
      if (remove) {
        transform.removeMarkByKey(key, base + i, 1, remove)
      }
    }
  }
}

function unchanged(characters, currOffset, offset, position, length) {
  for (let i = 0; i < length; i++) {
    const character = characters.get(currOffset + i - position)
    if (!character) {
      return false
    }
    const mark = character.marks.filter(typeIsOffset).first()
    if (!mark || (mark.data.get('offset') !== offset - position + i)) {
      return false
    }
  }
  return true
}

/**
 * Define a schema.
 *
 * @type {Object}
 */

const schema = {
  nodes: {
    'heading-one': props => <h2 {...props.attributes}>{props.children}</h2>,
    citation: (props) => {
      const { data } = props.node
      const citation = data.get('citation')
      const { url, title } = citation

      return (
        <a
          {...props.attributes}
          className="citation"
          href={url}
          title={title}
        >
          {props.children}
        </a>
      )
    }
  },
  marks: {
    bold: props => <strong>{props.children}</strong>,
    code: props => <code>{props.children}</code>,
    italic: props => <em>{props.children}</em>,
    underlined: props => <u>{props.children}</u>,
    spelling: (props) => {
      const { data } = props.mark
      const isIgnored = data.get('ignored')
      if (isIgnored) {
        return <span>{props.children}</span>
      }

      return (
        <span className={`spelling-error spelling-error-${data.get('ruleId')}`}>
          {props.children}
        </span>
      )
    }
  }
}

/**
 * The hovering menu example.
 *
 * @type {Component}
 */

class HoveringMenu extends React.Component {

  _request = null
  editor = null

  /**
   * Deserialize the raw initial state.
   *
   * @type {Object}
   */

  state = {
    menu: null,
    showCitationTool: false,
    spellChecker: null,
    state: Raw.deserialize(initialState, { terse: true }),
    suggestionOnDisplay: null,
  }

  /**
   * On update, update the menu.
   */

  componentDidMount = () => {
    this.updateSpellCheckerMenu()
  }

  componentDidUpdate = () => {
    this.updateSpellCheckerMenu()
  }

  componentWillUnmount = () => {
    if (this._request) {
      this._request.abort()
    }
  }

  /**
   * Check if the current selection has a mark with `type` in it.
   *
   * @param {String} type
   * @return {Boolean}
   */

  hasMark = (type) => {
    const { state } = this.state
    return state.marks.some(mark => mark.type == type)
  }

  /**
   * On change, save the new state.
   *
   * @param {State} state
   */

  onChange = (state) => {
    this.setState({ state })

    setTimeout(() => {
      this.debouncedSpellCheck()
      this.maybeSelectError()
      this.removeStaleSuggestions()
    }, 0)
  }

  onDocumentChange = (document, state) => {
    if (this.props.onDocumentChange) {
      const content = Raw.serialize(state)
      this.props.onDocumentChange(content)
    }
  }

  removeStaleSuggestions = () => {
    let { state } = this.state
    const transform = state.transform()

    state.document.getTextsAsArray().forEach((text) => {
      text.characters.forEach((character, offset, chars) => {
        const mark = character.marks.filter(typeIsSpelling).first()
        if (mark) {
          const length = mark.data.get('length')
          const position = mark.data.get('position')
          if ((position + 1 < length && !isSameError(chars, offset + 1, mark, add1)) ||
              (position > 0 && !isSameError(chars, offset - 1, mark, sub1))) {
            removeSpellingSuggestion(transform, text.key, chars, offset, position, length, mark)
          }
        }
      })
    })


    state = transform.apply(false)
    this.setState({ state })
  }

  spellCheck = async () => {
    let { state } = this.state
    const text = Plain.serialize(state)
    let suggestions

    state = this.addCharacterOffsetMarks(state)
    state = state.set('isNative', false)
    this.setState({ state })

    try {
      this._request = requestSpellCheck(text)
      suggestions = await this._request
    } finally {
      this._request = null
    }

    ({ state } = this.state)
    state = this.addSuggestions(state, suggestions)
    state = this.removeCharacterOffsetMarks(state)
    state = state.set('isNative', false)

    this.setState({ state })
  }

  addCharacterOffsetMarksToNodes = (nodes, startingOffset) => {
    let offset = startingOffset
    nodes = nodes.map((child) => {
      if (child.kind != 'text') {
        let childNodes
        ({ nodes: childNodes, offset } = this.addCharacterOffsetMarksToNodes(child.nodes, offset))
        child = child.set('nodes', childNodes)
        if (child.kind === 'block') {
          offset = offset + 1
        }
        return child
      }

      const characters = child.characters.map((ch, i) => {
        let { marks } = ch
        const mark = Mark.create({ type: 'offset', data: { offset }})
        marks = marks.add(mark)
        offset = offset + 1
        return ch.set('marks', marks)
      })
      return child.set('characters', characters)
    })

    return { nodes, offset }
  }

  addCharacterOffsetMarks = (state) => {
    console.time('addCharacterOffsetMarks') // eslint-disable-line no-console
    let { document } = state
    let { nodes } = document;
    ({ nodes } = this.addCharacterOffsetMarksToNodes(nodes, 0))
    document = document.set('nodes', nodes)
    state = state.set('document', document)
    console.timeEnd('addCharacterOffsetMarks') // eslint-disable-line no-console
    return state
  }

  removeCharacterOffsetMarksFromNodes = (nodes) => {
    return nodes.map((child) => {
      if (child.kind != 'text') {
        const childNodes = this.removeCharacterOffsetMarksFromNodes(child.nodes)
        child = child.set('nodes', childNodes)
        return child
      }

      const characters = child.characters.map((ch, i) => {
        let { marks } = ch
        marks = marks.filter(negate(typeIsOffset))
        return ch.set('marks', marks)
      })
      return child.set('characters', characters)
    })
  }

  removeCharacterOffsetMarks = (state) => {
    console.time('removeCharacterOffsetMarks') // eslint-disable-line no-console
    let { document } = state
    let { nodes } = document
    nodes = this.removeCharacterOffsetMarksFromNodes(nodes)
    document = document.set('nodes', nodes)
    state = state.set('document', document)
    console.timeEnd('removeCharacterOffsetMarks') // eslint-disable-line no-console
    return state
  }

  addSuggestionsToNodes = (nodes, suggestions) => {
    return nodes.map((child) => {
      if (suggestions.length === 0) {
        return child
      }

      if (child.kind != 'text') {
        const childNodes = this.addSuggestionsToNodes(child.nodes, suggestions)
        child = child.set('nodes', childNodes)
        return child
      }

      const characters = child.characters.map((ch, currOffset) => {
        if (suggestions.length === 0) {
          return ch
        }

        let { marks } = ch
        const offsetMark = marks.filter(typeIsOffset).first()

        marks = marks.filter(x => !typeIsSpelling(x) || isErrorIgnored(x))

        if (offsetMark) {
          const offset = offsetMark.data.get('offset')

          let suggestion = suggestions[0]
          while (suggestion && suggestion.offset + suggestion.length <= offset) {
            suggestions.shift()
            suggestion = suggestions[0]
          }

          if (!suggestion) {
            return ch
          }

          const position = offset - suggestion.offset
          const inRange = position >= 0 && position < suggestion.length

          if (inRange &&
              unchanged(child.characters, currOffset, offset, position, suggestion.length) &&
              !ignoredError(child.characters, currOffset, suggestion)) {
            const mark = Mark.create({
              type: 'spelling',
              data: {
                length: suggestion.length,
                position,
                message: suggestion.message,
                replacements: suggestion.replacements,
                ruleId: suggestion.rule.id,
                ignored: false,
              },
            })
            marks = marks.add(mark)
          }
        }

        return ch.set('marks', marks)
      })
      return child.set('characters', characters)
    })
  }

  addSuggestions = (state, suggestions) => {
    console.time('addSuggestions') // eslint-disable-line no-console
    let { document } = state
    let { nodes } = document
    const suggs = suggestions.filter(negate(ignoreSuggestion))
    nodes = this.addSuggestionsToNodes(nodes, suggs)
    document = document.set('nodes', nodes)
    state = state.set('document', document)
    console.timeEnd('addSuggestions') // eslint-disable-line no-console
    return state
  }

  maybeSpellCheck = () => {
    if (!this._request) {
      this.spellCheck()
    } else {
      // Request could be taking longer than the SPELL_CHECK_WAIT_TIME_MS so we
      // can queue up another request to take place after
      // SPELL_CHECK_WAIT_TIME_MS
      this.debouncedSpellCheck()
    }
  }

  debouncedSpellCheck = debounce(
    () => this.maybeSpellCheck(),
    SPELL_CHECK_WAIT_TIME_MS,
    { maxWait: SPELL_CHECK_MAX_WAIT_TIME_MS }
  )

  /**
   * When a mark button is clicked, toggle the current mark.
   *
   * @param {Event} e
   * @param {String} type
   */

  onClickMark = (e, type) => {
    e.preventDefault()
    let { state } = this.state

    state = state
      .transform()
      .toggleMark(type)
      .apply()

    this.setState({ state })
  }

  /**
   * When the portal opens, cache the menu element.
   *
   * @param {Element} portal
   */

  onOpen = (portal) => {
    this.setState({ menu: portal.firstChild })
  }

  onOpenSpellChecker = (portal) => {
    this.setState({ spellChecker: portal.firstChild })
  }

  /**
   * Render.
   *
   * @return {Element}
   */

  render = () => {
    return (
      <div>
        {this.renderMenu()}
        {this.renderSpellChecker()}
        {this.renderCitationTool()}
        {this.renderToolbar()}
        {this.renderEditor()}
      </div>
    )
  }

  onClickCitation = (e, citation) => {
    let { state } = this.state

    state = state
      .transform()
      .wrapInline({
        type: 'citation',
        data: {
          citation,
        },
      })
      .collapseToEnd()
      .focus()
      .apply()

    this.setState({
      showCitationTool: false,
      state,
    })
  }

  renderCitationChoice = (citation, i) => {
    const onClick = (e) => {
      e.preventDefault()
      this.onClickCitation(e, citation)
    }

    return (
      <li key={i}>
        <a onClick={onClick} href={citation.url}>
          {citation.domain} - {citation.title}
        </a>
      </li>
    )
  }

  onCitationToolClose = () => {
    this.setState({ showCitationTool: false })
  }

  /**
   * Render the citation tool.
   *
   * @return {Element}
   */

  renderCitationTool = () => {
    const { showCitationTool } = this.state
    return (
      <Portal
        closeOnEsc
        closeOnOutsideClick
        isOpened={showCitationTool}
        onClose={this.onCitationToolClose}
      >
        <div className="citation-hover-menu">
          <strong>Choose Citation</strong>
          <ul>
            {citations.map(this.renderCitationChoice)}
          </ul>
        </div>
      </Portal>
    )
  }

  /**
   * Render the hovering menu.
   *
   * @return {Element}
   */

  renderMenu = () => {
    return (
      <Portal isOpened onOpen={this.onOpen}>
        <div className="menu hover-menu">
          {this.renderMarkButton('bold', 'format_bold')}
          {this.renderMarkButton('italic', 'format_italic')}
          {this.renderMarkButton('underlined', 'format_underlined')}
          {this.renderMarkButton('code', 'code')}
        </div>
      </Portal>
    )
  }

  onClickReplacement = (e, value) => {
    let { state } = this.state
    const { anchorOffset, anchorKey } = state.selection
    const newOffset = anchorOffset + value.length
    const selection = Selection.create({
      anchorKey,
      anchorOffset: newOffset,
      focusKey: anchorKey,
      focusOffset: newOffset,
    })

    state = state
      .transform()
      .insertText(value)
      .select(selection)
      .apply()

    this.setState({
      state,
      suggestionOnDisplay: null
    }, () => {
      setTimeout(() => this.editor.focus(), 0)
    })
  }

  onIgnoreSuggestion = (e) => {
    const { state, suggestionOnDisplay } = this.state
    const { anchorKey: key, anchorOffset: base } = state.selection
    const characters = state.document.getDescendant(key).characters
    const transform = state.transform()
    const length = suggestionOnDisplay.data.get('length')
    const position = suggestionOnDisplay.data.get('position')
    const newOffset = base + length
    const selection = Selection.create({
      anchorKey: key,
      anchorOffset: newOffset,
      focusKey: key,
      focusOffset: newOffset,
    })

    for (let i = 0; i < length; i++) {
      const character = characters.get(base + i)
      const remove = character.marks.filter(matchesErrorMark(addX(i - position), suggestionOnDisplay)).first()
      const newData = remove.data.set('ignored', true)
      const replace = remove.set('data', newData)
      transform.removeMarkByKey(key, base + i, 1, remove)
      transform.addMarkByKey(key, base + i, 1, replace)
    }

    transform.select(selection)

    this.setState({
      state: transform.apply(),
      suggestionOnDisplay: null
    }, () => {
      setTimeout(() => this.editor.focus(), 0)
    })
  }

  renderReplacement = ({ value }) => {
    const onMouseDown = e => this.onClickReplacement(e, value)

    return (
      <li key={value} onMouseDown={onMouseDown}>{value}</li>
    )
  }

  renderSuggestionOnDisplay = () => {
    const { suggestionOnDisplay } = this.state
    if (!suggestionOnDisplay) {
      return null
    }

    const replacements = suggestionOnDisplay.data.get('replacements')
    const onMouseDown = e => this.onIgnoreSuggestion(e)
    const replacementsList = replacements.length === 0 ? null : (
      <ul className="suggestion-box-replacements">
        {replacements.map(this.renderReplacement)}
      </ul>
    )

    return (
      <div className="suggestion-box">
        <div className="suggestion-box-header">
          {suggestionOnDisplay.data.get('message')}
        </div>
        {replacementsList}
        <div onMouseDown={onMouseDown} className="suggestion-box-ignore">
          Ignore
        </div>
      </div>
    )
  }

  renderSpellChecker = () => {
    return (
      <Portal isOpened onOpen={this.onOpenSpellChecker}>
        <div className="menu hover-menu">
          {this.renderSuggestionOnDisplay()}
        </div>
      </Portal>
    )
  }

  /**
   * Render a mark-toggling toolbar button.
   *
   * @param {String} type
   * @param {String} icon
   * @return {Element}
   */

  renderMarkButton = (type, icon) => {
    const isActive = this.hasMark(type)
    const onMouseDown = e => this.onClickMark(e, type)

    return (
      <span className="button" onMouseDown={onMouseDown} data-active={isActive}>
        <span className="material-icons">{icon}</span>
      </span>
    )
  }

  /**
   * Render the Slate editor.
   *
   * @return {Element}
   */

  renderEditor = () => {
    const setEditorRef = ref => this.editor = ref

    return (
      <div className="editor">
        <Editor
          schema={schema}
          ref={setEditorRef}
          state={this.state.state}
          onChange={this.onChange}
          onDocumentChange={this.onDocumentChange}
          spellCheck={false}
        />
      </div>
    )
  }

  /**
   * Update the menu's absolute position.
   */

  maybeSelectError = () => {
    const { state, suggestionOnDisplay } = this.state
    const { anchorKey, anchorOffset, focusKey, focusOffset, isCollapsed, isBackward } = state.selection

    const shouldCloseSpellChecker = (
      state.isBlurred ||
      isBackward ||
      focusKey !== anchorKey ||
      (suggestionOnDisplay && isCollapsed)
    )
    if (shouldCloseSpellChecker) {
      this.setState({ suggestionOnDisplay: null })
      return
    }

    const length = focusOffset - anchorOffset
    const text = state.document.getDescendant(anchorKey)
    const character = text.characters.get(anchorOffset)
    if (!character) {
      this.setState({ suggestionOnDisplay: null })
      return
    }
    const suggestions = character.marks.filter(typeIsSpelling)
    if (suggestions.size === 0) {
      this.setState({ suggestionOnDisplay: null })
      return
    }

    if (length === 0) {
      const suggestion = suggestions.first()
      if (suggestion.data.get('ignored')) {
        return
      }

      const transform = state.transform()
      const newAnchorOffset = anchorOffset - suggestion.data.get('position')
      const newFocusOffset = newAnchorOffset + suggestion.data.get('length')
      const newState = transform
        .moveOffsetsTo(newAnchorOffset, newFocusOffset)
        .apply(false)
      this.setState({ state: newState, suggestionOnDisplay: suggestion })
      return
    }

    const suggestion = suggestions
      .filter(mark => mark.data.get('position') === 0)
      .filter(mark => mark.data.get('length') === length)
      .first()
    if (!suggestion) {
      this.setState({ suggestionOnDisplay: null })
    }
  }

  updateSpellCheckerMenu = () => {
    const { spellChecker, suggestionOnDisplay } = this.state
    if (!spellChecker) return

    if (!suggestionOnDisplay) {
      spellChecker.removeAttribute('style')
      return
    }

    let range
    try {
      const selection = window.getSelection()
      range = selection.getRangeAt(0)
    } catch (e) {
      return
    }

    const rect = range.getBoundingClientRect()
    spellChecker.style.opacity = 1
    spellChecker.style.top = `${rect.bottom + window.scrollY + 5}px`
    spellChecker.style.left = `${rect.left + window.scrollX}px`
  }

  /**
   * When a block button is clicked, toggle the block type.
   *
   * @param {Event} e
   * @param {String} type
   */

  onClickBlock = (e, type) => {
    e.preventDefault()
    let { state } = this.state
    const transform = state.transform()

    // Handle everything but list buttons.
    const isActive = this.hasBlock(type)
    transform
      .setBlock(isActive ? DEFAULT_NODE : type)

    state = transform.apply()
    this.setState({ state })
  }

  /**
   * Check if the any of the currently selected blocks are of `type`.
   *
   * @param {String} type
   * @return {Boolean}
   */

  hasBlock = (type) => {
    const { state } = this.state
    return state.blocks.some(node => node.type == type)
  }

  /**
   * Render a block-toggling toolbar button.
   *
   * @param {String} type
   * @param {String} icon
   * @return {Element}
   */

  renderBlockButton = (type, icon) => {
    const isActive = this.hasBlock(type)
    const onMouseDown = e => this.onClickBlock(e, type)

    return (
      <span className="button" onMouseDown={onMouseDown} data-active={isActive}>
        <span className="material-icons">{icon}</span>
      </span>
    )
  }

  /**
   * Render a mark-toggling toolbar button.
   *
   * @param {String} type
   * @param {String} icon
   * @return {Element}
   */

  renderMarkButton = (type, icon) => {
    const isActive = this.hasMark(type)
    const onMouseDown = e => this.onClickMark(e, type)

    return (
      <span className="button" onMouseDown={onMouseDown} data-active={isActive}>
        <span className="material-icons">{icon}</span>
      </span>
    )
  }

  /**
   * Render the toolbar.
   *
   * @return {Element}
   */

  renderToolbar = () => {
    return (
      <div className="menu toolbar-menu">
        {this.renderBlockButton('heading-one', 'title')}
        {this.renderCiteButton()}
      </div>
    )
  }

  /**
   * Check whether the current selection has a citation in it.
   *
   * @return {Boolean} hasCitations
   */

  hasCitations = () => {
    const { state } = this.state
    return state.inlines.some(inline => inline.type == 'citation')
  }

  onCite = (e) => {
    e.preventDefault()
    let { state } = this.state
    const hasCitations = this.hasCitations()

    if (hasCitations) {
      state = state
        .transform()
        .unwrapInline('citation')
        .collapseToEnd()
        .focus()
        .apply()
      this.setState({ state })
    } else {
      this.setState({ showCitationTool: true })
    }
  }

  renderCiteButton = () => {
    const isActive = this.hasMark('citation')
    return (
      <span className="button" onClick={this.onCite} data-active={isActive}>
        <span className="material-icons">link</span>
      </span>
    )
  }

}

/**
 * Export.
 */

export default HoveringMenu
