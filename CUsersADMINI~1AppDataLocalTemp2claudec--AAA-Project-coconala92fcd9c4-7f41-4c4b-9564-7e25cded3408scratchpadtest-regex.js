const regex = /https?:\/\/[^"\s\]+\/ai-render\/[^"\s\]+/g;

const testCases = [
  'https://example.com/ai-render/project1/image.jpg',
  'https://example.com/ai-render/project1/image.jpg?token=abc',
  'https://example.com/storage/v1/object/public/user-uploads/uid/ai-render/proj/file.jpg',
  'data:image/png;base64,abcd',
  'https://example.com/ai-render/proj/file.jpg',
  'text with https://example.com/ai-render/proj/file.jpg and more',
  '{"url":"https://example.com/ai-render/a/b.jpg"}',
  'https://example.com/ai-render/proj/file.jpg\n',
  '"https://example.com/ai-render/proj/file.jpg"',
  'https://example.com/ai-render/proj/file%20with%20space.jpg',
  'https://example.com/ai-render/proj/file.jpg)',
  'https://example.com/ai-render/a;b',
];

testCases.forEach(tc => {
  const match = tc.match(regex);
  console.log('Input:  ' + tc.substring(0, 80));
  console.log('Match:  ' + (match ? match[0] : 'NO MATCH'));
  console.log('');
});
