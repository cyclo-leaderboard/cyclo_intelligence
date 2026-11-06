import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import ReferenceLayoutPanel from './ReferenceLayoutPanel';

jest.mock('./FileBrowserModal', () => ({ onFileSelect }) => (
  <div>
    <button type="button" onClick={() => onFileSelect({ full_path: '/workspace/rosbag2/Task/2' })}>
      Pick episode 2
    </button>
    <button type="button" onClick={() => onFileSelect({ full_path: '/workspace/rosbag2/Task' })}>
      Pick parent folder
    </button>
  </div>
));

const store = configureStore({
  reducer: () => ({
    ros: { imageTopicList: [], assignedImageTopics: [] },
    tasks: { robotType: 'ffw_sg2_rev1' },
  }),
});

beforeEach(() => window.sessionStorage.clear());

test('moves through video episodes in numeric order and restores the selection after remount', async () => {
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(url.includes('/rosbag-list') ? {
      success: true,
      rosbags: ['10', '2', '1', 'notes'].map((name) => ({
        name,
        path: `/workspace/rosbag2/Task/${name}`,
        has_videos: name !== 'notes',
      })),
    } : { success: true, video_segments: [] }),
  }));

  const view = render(<Provider store={store}>
    <ReferenceLayoutPanel isActive onOverlayChange={jest.fn()} onClose={jest.fn()} />
  </Provider>);

  fireEvent.click(screen.getByText('Pick episode 2'));
  await screen.findByText('Episode 2/3');
  expect(screen.getByRole('textbox', { name: 'Episode folder' }))
    .toHaveValue('/workspace/rosbag2/Task/2');
  expect(screen.getByRole('button', { name: 'Choose episode folder' })).toBeInTheDocument();
  expect(screen.queryByText(/camera reference frame\(s\) ready/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next episode' }));
  await screen.findByText('Episode 3/3');
  expect(screen.getByRole('button', { name: 'Next episode' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous episode' }));
  await screen.findByText('Episode 2/3');

  expect(screen.queryByText(/Reference time|Reference only/)).not.toBeInTheDocument();
  expect(screen.getByText('More transparent ←')).toBeInTheDocument();
  expect(screen.getByText('→ More visible')).toBeInTheDocument();
  view.unmount();
  render(<Provider store={store}>
    <ReferenceLayoutPanel isActive onOverlayChange={jest.fn()} onClose={jest.fn()} />
  </Provider>);
  await screen.findByText('Episode 2/3');
  expect(screen.getByRole('textbox', { name: 'Episode folder' }))
    .toHaveValue('/workspace/rosbag2/Task/2');

  await waitFor(() => expect(global.fetch.mock.calls.filter(([url]) => url === '/data-api/rosbag-list/workspace/rosbag2/Task')).toHaveLength(2));
  expect(global.fetch.mock.calls.filter(([url]) => url.includes('/replay-data')).map(([url]) => url))
    .toContain('/data-api/replay-data/workspace/rosbag2/Task/10');
});

test('selects episode 0 from a parent folder and jumps to an entered folder number', async () => {
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(url.includes('/rosbag-list') ? {
      success: true,
      rosbags: ['10', '2', '0'].map((name) => ({
        name, path: `/workspace/rosbag2/Task/${name}`, has_videos: true,
      })),
    } : { success: true, video_segments: [] }),
  }));

  render(<Provider store={store}>
    <ReferenceLayoutPanel isActive onOverlayChange={jest.fn()} onClose={jest.fn()} />
  </Provider>);

  fireEvent.click(screen.getByText('Pick parent folder'));
  await screen.findByText('Episode 1/3');
  expect(screen.getByRole('textbox', { name: 'Episode folder' }))
    .toHaveValue('/workspace/rosbag2/Task/0');
  expect(screen.getByText('Number')).toBeInTheDocument();
  const number = screen.getByRole('spinbutton', { name: 'Episode number' });
  await waitFor(() => expect(number).toHaveValue(0));

  fireEvent.change(number, { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await screen.findByText('Episode 3/3');
  expect(screen.getByRole('textbox', { name: 'Episode folder' }))
    .toHaveValue('/workspace/rosbag2/Task/10');

  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  fireEvent.click(screen.getByRole('button', { name: 'Random' }));
  await screen.findByText('Episode 1/3');
  expect(screen.getByRole('textbox', { name: 'Episode folder' }))
    .toHaveValue('/workspace/rosbag2/Task/0');
  expect(number).toHaveValue(0);
  random.mockRestore();

  fireEvent.change(number, { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.getByText('Episode number 9 was not found.')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Episode folder' }))
    .toHaveValue('/workspace/rosbag2/Task/0');
});
