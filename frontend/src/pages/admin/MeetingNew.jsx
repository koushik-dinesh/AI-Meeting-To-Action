import { Link, useNavigate } from 'react-router';
import { createMeeting } from '../../api/meetings.js';
import { MeetingForm } from '../../components/MeetingForm.jsx';
import { Card } from '../../components/ui.jsx';

export function MeetingNewPage() {
  const navigate = useNavigate();

  async function handleSubmit(values) {
    const { meeting } = await createMeeting(values);
    navigate(`/admin/meetings/${meeting.id}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin/meetings" className="text-sm text-slate-500 hover:underline">
          ← Meetings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">New meeting</h1>
      </div>
      <Card>
        <MeetingForm submitLabel="Create meeting" onSubmit={handleSubmit} onCancel={() => navigate('/admin/meetings')} />
      </Card>
    </div>
  );
}
