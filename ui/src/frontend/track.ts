// Copyright (C) 2018 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as m from 'mithril';

import {TrackCanvasContext} from './track_canvas_context';
import {TrackShell} from './track_shell';

export const Track = {
  view({attrs}) {

    attrs.trackContext.fillStyle = '#ccc';
    attrs.trackContext.fillRect(0, 0, 1000, 73);

    attrs.trackContext.font = '16px Arial';
    attrs.trackContext.fillStyle = '#000';
    attrs.trackContext.fillText(attrs.name + ' rendered by canvas', 500, 20);

    return m(
        '.track',
        {
          style: {
            position: 'absolute',
            top: attrs.top.toString() + 'px',
            left: 0,
            width: '100%'
          }
        },
        m(TrackShell, attrs));
  }
} as m.Component<{name: string, trackContext: TrackCanvasContext, top: number}>;