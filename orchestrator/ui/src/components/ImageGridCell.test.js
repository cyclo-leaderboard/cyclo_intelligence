import React from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { act, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import ImageGridCell from './ImageGridCell';

const store = configureStore({ reducer: () => ({ ros: { rosHost: '127.0.0.1' } }) });

test('keeps one live stream after StrictMode remount during staggered setup', async () => {
  jest.useFakeTimers();
  try {
    const { container } = render(
      <React.StrictMode>
        <Provider store={store}>
          <ImageGridCell topic="/camera/image/compressed" aspect="3/4" idx={0}
            onClose={jest.fn()} onPlusClick={jest.fn()} />
        </Provider>
      </React.StrictMode>
    );
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(container.querySelectorAll('img[alt="/camera/image/compressed"]')).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});
