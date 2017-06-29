const chunkToNode = (text) => ({ start, end, citationResourceId }) => {
  const textNode = {
    kind: 'text',
    ranges: [{
      kind: 'range',
      text: text.substr(start, end - start),
      marks: [],
    }],
  };

  if (citationResourceId) {
    return {
      data: {
        citation: {
          id: citationResourceId,
          url: citationResourceId,
          title: citationResourceId,
          domain: citationResourceId,
        },
      },
      kind: 'inline',
      isVoid: false,
      type: 'citation',
      nodes: [textNode],
    };
  }

  return textNode;
};

const blockToNode = (entityMap) => ({ text, entityRanges }) => ({
  data: {},
  kind: 'block',
  isVoid: false,
  type: 'paragraph',
  nodes: entityRanges.reduce(([{ end }, tail, ...head], { offset, length, key }) => ([
    { start: offset + length, end },
    { start: offset, end: offset + length, ...entityMap[key].data },
    { start: tail.end, end: offset },
    tail,
    ...head,
  ]), [{ start: 0, end: text.length, data: {} }, { start: 0, end: 0, data: {} }])
  .reverse()
  .filter(({ start, end }) => start !== end)
  .map(chunkToNode(text)),
});

/**
 * Convert draft to slate
 */
export const convertDraftToSlate = ({ entityMap, blocks }) => ({
  kind: 'state',
  document: {
    data: {},
    kind: 'document',
    nodes: blocks.map(blockToNode(entityMap)),
  },
});
